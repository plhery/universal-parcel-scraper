import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, GLOBALEXP_MAX_BYTES, isChallenge, normalizeGlobalexpNumber, parseGlobalexp, PROVIDER } from './parser.js';

export { normalizeGlobalexpNumber, parseGlobalexp } from './parser.js';

/** The firm's site, whose search box opens an order's page. */
export const GLOBALEXP_SITE = 'https://www.global-express168.com';
const REDIRECTS = [301, 302, 303, 307, 308];
// The server is in China or Hong Kong and sometimes slow to answer from abroad.
const DEFAULT_BUDGET_MS = 20_000;

/** The page the site's search box opens for one order. */
export function globalexpLookupUrl(number: string): string {
  return `${GLOBALEXP_SITE}/search_kuai_di/search/orderid/${encodeURIComponent(number)}`;
}

export class GlobalexpTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The number alone, with no session or account.
    const { response, bytes } = await fetchBounded(globalexpLookupUrl(number), {
      // The site answers HTTP 500 to a request without a language it can read, such as Node's `*`.
      signal, headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN', 'User-Agent': userAgentOf(this.options.userAgent) },
    }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: GLOBALEXP_MAX_BYTES,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    // An unknown number is HTTP 200 too; anything else is a moved page, a refusal or a browser check.
    if (response.status !== 200) {
      if (response.status === 403 && isChallenge(decodeText(bytes))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
      throw new TransportError(PROVIDER, `${PROVIDER} tracking page is unavailable`, { status: response.status });
    }
    return parseGlobalexp(decodeText(bytes).replace(/^\uFEFF/u, ''), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeGlobalexpNumber(raw);
    // A request that fails to reach the page, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GlobalexpTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeGlobalexpNumber(number))),
  };
};
