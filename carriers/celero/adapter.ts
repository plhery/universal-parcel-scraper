import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CELERO_ENDPOINT, CELERO_MAX_BYTES, CELERO_PAGE, celeroJson, normalizeCeleroNumber, parseCelero, PROVIDER } from './parser.js';

export class CeleroTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeCeleroNumber(raw);
    return runSteps({ carrier: 'celero', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      // The form's Turnstile widget guards nothing: its script posts the numbers on its own.
      const { response, bytes } = await fetchBounded(CELERO_ENDPOINT, { method: 'POST', signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: CELERO_PAGE.slice(0, -1), Referer: CELERO_PAGE,
          'User-Agent': userAgentOf(this.options.userAgent) },
        body: JSON.stringify({ awbs: [number] }) }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: CELERO_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [404, 410], fetcher: this.options.fetcher,
      }).catch(error => { signal.throwIfAborted(); throw error; });
      signal.throwIfAborted();
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Celero tracking service is unavailable', { status: response.status });
      return parseCelero(celeroJson(decodeText(bytes)), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new CeleroTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'celero', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
