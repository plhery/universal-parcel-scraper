import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { HDT_PAGE, normalizeHdtNumber, parseHdt, PROVIDER } from './parser.js';

export { normalizeHdtNumber, parseHdt } from './parser.js';
const REDIRECTS = [301, 302, 303, 307, 308];

/** The tracking page's address for an order number, as its search form opens it. */
export const hdtPageUrl = (number: string): string => `${HDT_PAGE}?track_number=${encodeURIComponent(number)}`;

export class HdtTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeHdtNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page the search form opens, with no session, token or account.
      const { response, bytes } = await fetchBounded(hdtPageUrl(number), { method: 'GET', signal,
        headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'hu-HU,hu;q=0.9', 'User-Agent': userAgentOf(this.options.userAgent) } },
      { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: 1_000_000, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410] });
      if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'Home Delivery Team refused its guest request');
      // An unknown order is HTTP 200 too; anything else is a moved page.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Home Delivery Team tracking page moved', { status: response.status });
      return parseHdt(decodeText(bytes), number);
    };
    // A request that fails to reach the server, or hangs, gets one more try in the rest of the budget.
    return runSteps({ carrier: 'home-delivery-team', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new HdtTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'home-delivery-team', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
