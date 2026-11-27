import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, CHINASTAR_MAX_BYTES, normalizeChinastarNumber, notJson, parseChinastar, PROVIDER } from './parser.js';

export { chinastarStatusText, normalizeChinastarNumber, parseChinastar } from './parser.js';

/** The service the tracking page on the firm's site asks, on its own port. */
export const CHINASTAR_API = 'https://mip.chinastarlogistics.com:2443/openApi_v2/golbalLinkNodeGwAndFast100';
const REDIRECTS = [301, 302, 303, 307, 308];
// The server in China is sometimes slow to accept a connection from abroad.
const DEFAULT_BUDGET_MS = 20_000;

/** The address the page posts one number to; it names the number in the query as well as the body. */
export function chinastarLookupUrl(number: string): string {
  return `${CHINASTAR_API}?${new URLSearchParams({ danhao: number })}`;
}

export class ChinastarTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The number alone, as the page's first request sends it, with no session, token or account.
    const { response, bytes } = await fetchBounded(chinastarLookupUrl(number), {
      method: 'POST', signal, body: JSON.stringify({ cecNo: number }), headers: {
        Accept: 'application/json, text/javascript, */*', 'Content-Type': 'application/json',
        'User-Agent': userAgentOf(this.options.userAgent),
      },
    }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: CHINASTAR_MAX_BYTES,
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
    return parseChinastar(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeChinastarNumber(raw);
    // A request that fails to reach the service, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ChinastarTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeChinastarNumber(number))),
  };
};
