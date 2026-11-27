import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, normalizeWlkgoNumber, notJson, parseWlkgo, PROVIDER, WLKGO_MAX_BYTES } from './parser.js';

export { normalizeWlkgoNumber, parseWlkgo, wlkgoAction } from './parser.js';

/** The service WLKGO's delivery query page asks, one number a request. */
export const WLKGO_API = 'https://delivery.wlkgo.com/ajax/PackageTrack.ashx';
const REDIRECTS = [301, 302, 303, 307, 308];
// The server in China is sometimes slow to accept a connection from abroad.
const DEFAULT_BUDGET_MS = 20_000;

/** The page's request without its JSONP callback, which makes the service answer plain JSON. */
export function wlkgoLookupUrl(number: string): string {
  return `${WLKGO_API}?${new URLSearchParams({ Act: 'getOrderTrackInfo', orderNO: number })}`;
}

export class WlkgoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The number alone, with no session, token or account.
    const { response, bytes } = await fetchBounded(wlkgoLookupUrl(number), {
      signal, headers: { Accept: 'application/json, text/javascript, */*', 'User-Agent': userAgentOf(this.options.userAgent) },
    }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: WLKGO_MAX_BYTES,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 400, 404, 405, 410] });
    // An unknown number is HTTP 200 too; anything else is a moved route or a request the service now refuses.
    if (response.status !== 200) throw new TransportError(PROVIDER, `${PROVIDER} tracking lookup is unavailable`, { status: response.status });
    const body = decodeText(bytes).replace(/^\uFEFF/, '');
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      notJson(body);
    }
    return parseWlkgo(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeWlkgoNumber(raw);
    // A request that fails to reach the service, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new WlkgoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeWlkgoNumber(number))),
  };
};
