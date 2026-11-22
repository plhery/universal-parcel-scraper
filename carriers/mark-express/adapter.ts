import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isMarkChallenge, isMarkErrorPage, MARK_DETAIL, MARK_MAX_BYTES, normalizeMarkNumber, parseMark, PROVIDER } from './parser.js';

export { MARK_DETAIL } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];

export class MarkTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMarkNumber(raw);
    // An attempt that fails to reach the site, or hangs, gets one more: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP
    // status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'mark-express', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }

  /** The tracking page for the number, which needs no cookie, captcha or browser. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(`${MARK_DETAIL}?docno=${encodeURIComponent(number)}`, {
      method: 'GET', signal, headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent) },
    }, { provider: PROVIDER, timeoutMs, maxBytes: MARK_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
    if (REDIRECTS.includes(response.status)) {
      // The site sends a request it fails to its blank error page, which is no answer; any other redirect is a moved route.
      if (isMarkErrorPage(response.headers.get('location'))) throw new IndeterminateError(PROVIDER, 'Mark Express sent the lookup to its error page');
      throw new TransportError(PROVIDER, 'Mark Express moved its tracking page');
    }
    const body = decodeText(bytes);
    if (response.status === 403) {
      throw new ChallengeError(PROVIDER, isMarkChallenge(body) ? 'Mark Express answered with a browser check' : 'Mark Express refused the lookup',
        { status: 403 });
    }
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Mark Express\'s tracking page is unavailable');
    return parseMark(body, number);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MarkTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'mark-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeMarkNumber(number))),
  };
};
