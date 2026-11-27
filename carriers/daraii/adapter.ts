import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DARAII_LOOKUP, DARAII_MAX_BYTES, normalizeDaraiiNumber, parseDaraiiReply, PROVIDER } from './parser.js';

export class DaraiiTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeDaraiiNumber(raw);
    return runSteps({ carrier: 'daraii', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      // The page's script posts the number as a form field and asks for JSON.
      const { response, bytes } = await fetchBounded(DARAII_LOOKUP, { method: 'POST', signal,
        body: new URLSearchParams({ orderNo: number }).toString(),
        headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: DARAII_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [404], fetcher: this.options.fetcher,
      }).catch(error => { signal.throwIfAborted(); throw error; });
      signal.throwIfAborted();
      return parseDaraiiReply(response.status, decodeText(bytes), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new DaraiiTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'daraii', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
