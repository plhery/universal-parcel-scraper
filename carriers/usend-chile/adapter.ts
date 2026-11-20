import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeUsendNumber, parseUsend, PROVIDER, USEND_MAX_BYTES } from './parser.js';

/** The guest tracker's page for one guide, which usend.cl links each number to. */
export function usendTrackingUrl(number: string): string {
  return `https://portal.usend.cl/rastrear-shipper/${encodeURIComponent(number)}`;
}

const REDIRECTS = [301, 302, 303, 307, 308];

export class UsendTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeUsendNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(usendTrackingUrl(number), { signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'es-CL,es;q=0.9', Referer: 'https://usend.cl/',
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: USEND_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410, 429] });
      // The page answers a guide it holds, and one it does not, with HTTP 200.
      if (response.status === 429) throw new RateLimitedError(PROVIDER);
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'USEND refused the tracking page');
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'USEND redirected its tracking page');
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'USEND tracking page is unavailable');
      return parseUsend(decodeText(bytes), number);
    };
    // A read that fails to reach USEND, or hangs, gets one more: the first gets
    // half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'usend-chile', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new UsendTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'usend-chile', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
