import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CAMBODIA_POST_MAX_BYTES, cambodiaPostItemUrl, normalizeCambodiaPostNumber, parseCambodiaPost, PROVIDER } from './parser.js';

export { CAMBODIA_POST_SEARCH, parseCambodiaPost } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// The page answers an unknown code itself: a missing route is not a missing item.
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 15_000;

export class CambodiaPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeCambodiaPostNumber(raw);
    // One request opens the page the tracking form opens for the code, in the site's default
    // Khmer; the scans are in English either way. It needs no cookie, token or browser.
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(cambodiaPostItemUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: CAMBODIA_POST_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      // The site sends what it does not serve to a guest, such as /tracking, to its login page.
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Cambodia Post tracking page is unavailable', { status: response.status });
      }
      return parseCambodiaPost(decodeText(bytes), number);
    };
    // A request that fails to reach the site, or hangs, gets one more: the first gets half of
    // the budget, so the retry fits in the rest. An HTTP status, a rate limit included, is never
    // sent again.
    return runSteps({ carrier: 'cambodia-post', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CambodiaPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'cambodia-post', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
