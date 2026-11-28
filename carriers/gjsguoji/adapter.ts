import { accepted, recognizeFromLookup, type AdapterFactory, type Recognition, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { CARRIER, GJS_LOOKUP, GJS_MAX_BYTES, gjsJson, gjsLookupBody, normalizeGjsNumber, parseGjs, PROVIDER } from './parser.js';

export { GJS_LOOKUP, GJS_TRACKER, gjsTrackerUrl, gjsWording, normalizeGjsNumber, parseGjs } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

export class GjsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The tracking page posts the number as JSON, with no session or token; the service refuses a form body.
    const { response, bytes } = await fetchBounded(GJS_LOOKUP, { method: 'POST', signal, body: gjsLookupBody(number), headers: {
      Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: GJS_MAX_BYTES, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
      redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 403, 429] });
    if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response.headers.get('retry-after')));
    // CloudFront's firewall refuses a request it blocks with 403.
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'GJS Express refused the lookup', { status: 403 });
    // An unknown number is HTTP 200 too; a redirect is a moved service.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'GJS Express tracking lookup is unavailable', { status: response.status });
    return parseGjs(gjsJson(decodeText(bytes)), number, Date.now());
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeGjsNumber(raw);
    // A request that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }

  /** Whether the service holds the number: a parcel without a row is held. */
  recognize(raw: string, context: TrackingContext = {}): Promise<Recognition> {
    return recognizeFromLookup(() => this.fetch(raw, context), () => accepted(() => normalizeGjsNumber(raw)));
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GjsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
