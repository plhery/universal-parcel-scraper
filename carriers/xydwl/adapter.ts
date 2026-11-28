import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { CARRIER, normalizeXydwlNumber, parseXydwl, PROVIDER, XYDWL_MAX_BYTES, xydwlJson, xydwlRequestBody } from './parser.js';

export { normalizeXydwlNumber, parseXydwl, xydwlText } from './parser.js';

/** The tracking service the site's result page posts the number to, on the firm's own server. */
export const XYDWL_TRACK = 'http://112.74.160.148:8086/glkj/customerservice/customerservicetrack/getOutSideTracks';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];

export class XydwlTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The result page's request: the number alone, with no cookie, session or account.
    const { response, bytes } = await fetchBounded(XYDWL_TRACK, { method: 'POST', signal, body: xydwlRequestBody(number), headers: {
      Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: XYDWL_MAX_BYTES, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
      redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE, 429] });
    if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response.headers.get('retry-after')));
    // An unknown number is HTTP 200 too; a redirect or a missing route is a moved service.
    if (response.status !== 200) throw new TransportError(PROVIDER, `${PROVIDER} tracking service is unavailable`, { status: response.status });
    return parseXydwl(xydwlJson(decodeText(bytes)), number, Date.now());
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeXydwlNumber(raw);
    // A request that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: the waybills are a dense counter, so a waybill under a number does not show
// that the parcel asked about is the firm's.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new XydwlTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
