import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, normalizePigeonshipNumber, parsePigeonshipPage, PIGEONSHIP_MAX_BYTES, pigeonshipUrl, PROVIDER } from './parser.js';

export class PigeonshipTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizePigeonshipNumber(raw);
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const { response, bytes } = await fetchBounded(pigeonshipUrl(number), { signal,
        headers: { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: PIGEONSHIP_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [404], fetcher: this.options.fetcher,
      }).catch((error: unknown) => { signal.throwIfAborted(); throw error; });
      signal.throwIfAborted();
      return parsePigeonshipPage(response.status, decodeText(bytes), number);
    } }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PigeonshipTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizePigeonshipNumber(number))),
  };
};
