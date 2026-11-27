import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, HJWL_MAX_BYTES, normalizeHjwlNumber, notJson, parseHjwl, PROVIDER } from './parser.js';

export { normalizeHjwlNumber, parseHjwl } from './parser.js';

/** The service that gives a waybill's nodes without paging, as the public query page's list does. */
export const HJWL_API = 'https://www.hjwl.ltd/api/logisticsNodes/findByNumber';
/** The site whose public query page lists the nodes. */
export const HJWL_SITE = 'https://www.hjwl.ltd/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The server in China is sometimes slow to accept a connection from abroad.
const DEFAULT_BUDGET_MS = 20_000;

/** The nodes the service gives for one number. */
export function hjwlLookupUrl(number: string): string {
  return `${HJWL_API}?${new URLSearchParams({ number })}`;
}

export class HjwlTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The number alone, with no session, token or account.
    const { response, bytes } = await fetchBounded(hjwlLookupUrl(number), { method: 'GET', signal, headers: {
      Accept: 'application/json, text/plain, */*', Referer: HJWL_SITE, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: HJWL_MAX_BYTES,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 400, 401, 404, 410] });
    // An unknown number is HTTP 200 too; anything else is a moved route or a request the service now refuses.
    if (response.status !== 200) throw new TransportError(PROVIDER, `${PROVIDER} tracking lookup is unavailable`, { status: response.status });
    const body = decodeText(bytes).replace(/^\uFEFF/, '');
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      notJson(body);
    }
    return parseHjwl(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeHjwlNumber(raw);
    // A request that fails to reach the service, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new HjwlTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeHjwlNumber(number))),
  };
};
