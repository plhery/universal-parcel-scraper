import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { CARRIER, normalizeStwlesNumber, parseStwles, PROVIDER, STWLES_MAX_BYTES } from './parser.js';

export { normalizeStwlesNumber, parseStwles, stwlesText } from './parser.js';

/** The tracking page the site's form posts a number to. The host answers plain HTTP only. */
export const STWLES_TRACK = 'http://api.stwles.com/stwl/order/orderFlowQueryByCwb';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 405, 410];

export class StwlesTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The site's form: the number alone, with no cookie, session or account.
    const { response, bytes } = await fetchBounded(STWLES_TRACK, { method: 'POST', signal, headers: {
      Accept: 'text/html,application/xhtml+xml', 'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: new URLSearchParams({ cwb: number }).toString() }, { provider: PROVIDER, fetcher: this.options.fetcher,
      maxBytes: STWLES_MAX_BYTES, timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual',
      allowHttpStatuses: [...REDIRECTS, ...GONE, 429] });
    if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response.headers.get('retry-after')));
    // An unknown number is HTTP 200 too; a redirect or a missing page is a moved route.
    if (response.status !== 200) throw new TransportError(PROVIDER, `${PROVIDER} tracking page is unavailable`, { status: response.status });
    return parseStwles(decodeText(bytes), number, Date.now());
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeStwlesNumber(raw);
    // A request that fails to reach the site, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new StwlesTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeStwlesNumber(number))),
  };
};
