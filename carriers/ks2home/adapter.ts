import { accepted, recognizeFromLookup, type AdapterFactory, type Recognition, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { CARRIER, KS2HOME_MAX_BYTES, ks2homeQueryUrl, normalizeKs2homeNumber, parseKs2home, PROVIDER } from './parser.js';

export { KS2HOME_QUERY, ks2homeQueryUrl, normalizeKs2homeNumber, parseKs2home } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

export class Ks2homeTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The site serves its waybill page over HTTP alone, with no session the lookup needs.
    const { response, bytes } = await fetchBounded(ks2homeQueryUrl(number), { method: 'GET', signal, headers: {
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: KS2HOME_MAX_BYTES, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
      redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 403, 429] });
    if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response.headers.get('retry-after')));
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'Ks2Home refused the lookup', { status: 403 });
    // An unknown number is HTTP 200 too; a redirect is a moved page.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Ks2Home tracking page is unavailable', { status: response.status });
    return parseKs2home(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeKs2homeNumber(raw);
    // A request that fails to reach the site, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }

  /** Whether the site holds the number: a waybill without a row is held. */
  recognize(raw: string, context: TrackingContext = {}): Promise<Recognition> {
    return recognizeFromLookup(() => this.fetch(raw, context), () => accepted(() => normalizeKs2homeNumber(raw)));
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new Ks2homeTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
