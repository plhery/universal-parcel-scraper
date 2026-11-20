import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { BLITZ_MAX_BYTES, BLITZ_ORIGIN, BLITZ_URL, blitzPayload, blitzRequest, normalizeBlitzNumber, parseBlitz, PROVIDER } from './parser.js';

export class BlitzTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeBlitzNumber(raw);
    return runSteps({ carrier: 'blitznow', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const { response, bytes } = await fetchBounded(BLITZ_URL, { method: 'POST', signal, body: JSON.stringify(blitzRequest(number)),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: BLITZ_ORIGIN, Referer: `${BLITZ_ORIGIN}/`,
          'User-Agent': userAgentOf(this.options.userAgent) } }, {
        // An unknown number is an HTTP 500 that says so; the parser reads it.
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: BLITZ_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [500],
      }).catch(error => { signal.throwIfAborted(); throw error; });
      signal.throwIfAborted();
      return parseBlitz(blitzPayload(decodeText(bytes), response.status), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new BlitzTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'blitznow', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
