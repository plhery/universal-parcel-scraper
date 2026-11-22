import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { xExpressRsRequestNumber } from './number.js';
import { parseXExpressRs, PROVIDER, X_EXPRESS_RS_PAGE } from './parser.js';

export { xExpressRsRequestNumber } from './number.js';
export { parseXExpressRs } from './parser.js';
const REDIRECTS = [301, 302, 303, 307, 308];

/** The share link for a shipment number, as the tracker's result page publishes it. */
export const xExpressRsPageUrl = (number: string): string => `${X_EXPRESS_RS_PAGE}/${encodeURIComponent(number)}`;

export class XExpressRsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = xExpressRsRequestNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The share link needs no reCAPTCHA token, sum or session, unlike the search form's post.
      const { response, bytes } = await fetchBounded(xExpressRsPageUrl(number), { method: 'GET', signal,
        headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'sr-RS,sr;q=0.9', 'User-Agent': userAgentOf(this.options.userAgent) } },
      { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: 1_000_000, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410] });
      if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'X Express Serbia refused its guest request');
      // An unknown number is HTTP 200 too; anything else is a moved page.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'X Express Serbia tracking page moved', { status: response.status });
      return parseXExpressRs(decodeText(bytes), number);
    };
    // A request that fails to reach the server, or hangs, gets one more try in the rest of the budget.
    return runSteps({ carrier: 'x-express-rs', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new XExpressRsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'x-express-rs', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
