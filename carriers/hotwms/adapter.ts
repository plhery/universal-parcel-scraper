import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, HOTWMS_MAX_BYTES, normalizeHotwmsNumber, notJson, parseHotwms, PROVIDER } from './parser.js';

export { normalizeHotwmsNumber, parseHotwms } from './parser.js';

/** The service the tracking page on hotwms.com asks, one path per number. */
export const HOTWMS_API = 'https://api.hotwms.com/tracking/';
/** The site the tracking page is on, which answers plain HTTP only. */
export const HOTWMS_SITE = 'http://www.hotwms.com';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

/** The history the service gives for one number. */
export function hotwmsLookupUrl(number: string): string {
  return `${HOTWMS_API}${encodeURIComponent(number)}`;
}

export class HotwmsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The number alone, with the tracking page's origin, and no session, token or account.
    const { response, bytes } = await fetchBounded(hotwmsLookupUrl(number), { method: 'GET', signal, headers: {
      Accept: 'application/json, text/javascript, */*', Origin: HOTWMS_SITE, Referer: `${HOTWMS_SITE}/trace.html`,
      'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: HOTWMS_MAX_BYTES,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 400, 403, 404, 410] });
    // An unknown number is HTTP 200 too; a 403 is the gateway's answer for a route it does not have.
    if (response.status !== 200) throw new TransportError(PROVIDER, `${PROVIDER} tracking lookup is unavailable`, { status: response.status });
    const body = decodeText(bytes).replace(/^\uFEFF/, '');
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      notJson(body);
    }
    return parseHotwms(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeHotwmsNumber(raw);
    // A request that fails to reach the service, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new HotwmsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeHotwmsNumber(number))),
  };
};
