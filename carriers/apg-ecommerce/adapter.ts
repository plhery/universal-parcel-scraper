import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/boundedFetch.js';
import { userAgentOf } from '../../core/transport/userAgent.js';
import { APG_MAX_BYTES, apgTrackingUrl, normalizeApgReference, parseApgHistory, PROVIDER } from './parser.js';

export class ApgEcommerceTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeApgReference(raw);
    const url = apgTrackingUrl(number);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { signal,
        headers: { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) } },
      { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs, maxBytes: APG_MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [301, 302, 303, 307, 308, 401, 403, 404, 410] });
      signal.throwIfAborted();
      if ([401, 403].includes(response.status) || response.headers.get('cf-mitigated') === 'challenge') {
        throw new ChallengeError(PROVIDER, 'APG refused guest tracking', { status: response.status });
      }
      if (response.status !== 200 || response.url && response.url !== url) {
        throw new TransportError(PROVIDER, 'APG tracking route is unavailable', { status: response.status });
      }
      return parseApgHistory(decodeText(bytes), number);
    };
    return runSteps({ carrier: 'apg-ecommerce', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new ApgEcommerceTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'apg-ecommerce', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
