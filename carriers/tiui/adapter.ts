import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isTiuiNotFound, parseTiui, PROVIDER, TIUI_MAX_BYTES, tiuiFolio } from './parser.js';

/** The guide service Tiui's tracking page asks, without a session. */
export const TIUI_GUIDE = 'https://tiuiamigo.tiui.mx/api/guia/';

export function tiuiGuideUrl(raw: string): string {
  return `${TIUI_GUIDE}${encodeURIComponent(tiuiFolio(raw))}`;
}

export class TiuiTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const url = tiuiGuideUrl(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'Accept-Language': 'es-MX,es;q=0.9', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TIUI_MAX_BYTES,
        fetcher: this.options.fetcher, allowHttpStatuses: [403, 404, 429, 503] });
      if (response.status === 429) throw new RateLimitedError(PROVIDER);
      if (response.status === 403 || response.status === 503) {
        if (response.headers.get('cf-mitigated') === 'challenge') throw new ChallengeError(PROVIDER, 'Tiui answered with a browser check');
        throw new TransportError(PROVIDER, 'Tiui refused the lookup', { status: response.status });
      }
      if (response.status === 404) {
        // Only the service's own answer is a missing guide; another 404 is a moved route.
        let body: unknown;
        try { body = parseJsonBytes(bytes, PROVIDER); } catch { body = undefined; }
        if (isTiuiNotFound(body)) throw new NotFoundError(PROVIDER);
        throw new TransportError(PROVIDER, 'Tiui tracker is unavailable', { status: 404 });
      }
      return parseTiui(parseJsonBytes(bytes, PROVIDER), raw);
    };
    // A read that fails to reach Tiui, or hangs, gets one more try: the first
    // gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'tiui', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers Tiui for a number, so preflight
// never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new TiuiTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'tiui', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
