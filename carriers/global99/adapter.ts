import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, GLOBAL99_MAX_BYTES, isChallenge, normalizeGlobal99Number, parseGlobal99, PROVIDER } from './parser.js';

export { global99Text, normalizeGlobal99Number, parseGlobal99 } from './parser.js';

/** The firm's tracking page. Its certificate has expired, so the page is asked over HTTP, as its own links do. */
export const GLOBAL99_PAGE = 'http://www.global-99.com/source/article.php';
const REDIRECTS = [301, 302, 303, 307, 308];
// The server is in China and sometimes slow to answer from abroad.
const DEFAULT_BUDGET_MS = 20_000;

/** The page's search form, sent as its GET. */
export function global99LookupUrl(number: string): string {
  return `${GLOBAL99_PAGE}?${new URLSearchParams({ act: 'search', tid: '56', ydh: number })}`;
}

export class Global99Tracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The number alone, with no session or account.
    const { response, bytes } = await fetchBounded(global99LookupUrl(number), {
      signal, headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent) },
    }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: GLOBAL99_MAX_BYTES,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    // An unknown number is HTTP 200 too; anything else is a moved page, a refusal or a browser check.
    if (response.status !== 200) {
      if (response.status === 403 && isChallenge(decodeText(bytes))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
      throw new TransportError(PROVIDER, `${PROVIDER} tracking page is unavailable`, { status: response.status });
    }
    return parseGlobal99(decodeText(bytes).replace(/^\uFEFF/, ''), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeGlobal99Number(raw);
    // A request that fails to reach the page, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new Global99Tracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeGlobal99Number(number))),
  };
};
