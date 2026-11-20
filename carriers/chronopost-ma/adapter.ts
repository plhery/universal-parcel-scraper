import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CHRONOPOST_MA_ENDPOINT, CHRONOPOST_MA_MAX_BYTES, chronopostMaReply, normalizeChronopostMaNumber, parseChronopostMa, PROVIDER } from './parser.js';

export class ChronopostMaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeChronopostMaNumber(raw);
    return runSteps({ carrier: 'chronopost-ma', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const { response, bytes } = await fetchBounded(CHRONOPOST_MA_ENDPOINT, { method: 'POST', signal,
        headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/json; charset=utf-8',
          'X-Requested-With': 'XMLHttpRequest', 'User-Agent': userAgentOf(this.options.userAgent) },
        // `Mode` 2 is the page's own choice: its web service, rather than its database.
        body: JSON.stringify({ SendingNumber: number, Mode: 2 }) }, {
        provider: PROVIDER, timeoutMs: remainingMs, maxBytes: CHRONOPOST_MA_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [500], fetcher: this.options.fetcher,
      }).catch(error => { signal.throwIfAborted(); throw error; });
      signal.throwIfAborted();
      return parseChronopostMa(chronopostMaReply(response.status, decodeText(bytes)), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new ChronopostMaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'chronopost-ma', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
