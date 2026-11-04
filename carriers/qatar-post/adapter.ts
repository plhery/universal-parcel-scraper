import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/boundedFetch.js';
import { userAgentOf } from '../../core/transport/userAgent.js';
import { UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { qatarGuestToken } from './guest.js';
import { normalizeQatarPostNumber, parseQatarPostResponse, PROVIDER, QATAR_MAX_BYTES } from './parser.js';

export const QATAR_GUEST_TRACKING = 'https://web.qatarpost.qa/QPAPPDBN/api/CustomerOrdersDetails/track-order-details/';
export class QatarPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}
  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeQatarPostNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      try {
        const { response, bytes } = await fetchBounded(QATAR_GUEST_TRACKING + number, { signal, headers: {
          Accept: 'application/json, text/plain, */*', Platform: 'Mobile', 'Guest-API-Token': qatarGuestToken(),
          'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
          maxBytes: QATAR_MAX_BYTES, allowHttpStatuses: [400, 403, 404] });
        signal.throwIfAborted();
        return parseQatarPostResponse(decodeText(bytes), response.status, number);
      } catch (error) {
        // The generated guest header is private request state, never an error diagnostic.
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
        if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
        throw error;
      }
    };
    return runSteps({ carrier: 'qatar-post', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new QatarPostTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'qatar-post', steps: ['direct', 'retry'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeQatarPostNumber(number))) };
};
