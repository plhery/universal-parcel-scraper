import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { NotFoundError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeOverseasNumber, OVERSEAS_MAX_BYTES, OVERSEAS_ORIGIN, OVERSEAS_URL, overseasFields, overseasPayload, overseasRequest,
  parseOverseas, PROVIDER } from './parser.js';

export class OverseasTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeOverseasNumber(raw);
    return runSteps({ carrier: 'overseas-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const started = Date.now();
      const fields = overseasFields(number);
      for (const [index, field] of fields.entries()) {
        const { bytes } = await fetchBounded(OVERSEAS_URL, { method: 'POST', signal, body: JSON.stringify(overseasRequest(number, field)),
          // English wording; without a language the service writes each scan's code in its place.
          headers: { Accept: 'application/json;charset=utf-8', 'Accept-Language': 'en-US', 'Content-Type': 'application/json',
            Origin: OVERSEAS_ORIGIN, Referer: `${OVERSEAS_ORIGIN}/`, 'User-Agent': userAgentOf(this.options.userAgent) } }, {
          provider: PROVIDER, timeoutMs: Math.max(1, remainingMs - (Date.now() - started)), maxBytes: OVERSEAS_MAX_BYTES,
          redirect: 'manual', fetcher: this.options.fetcher,
        }).catch(error => { signal.throwIfAborted(); throw error; });
        signal.throwIfAborted();
        try {
          return parseOverseas(overseasPayload(decodeText(bytes)), number);
        } catch (error) {
          // A fourteen-digit code that names no shipment may still be a parcel number.
          if (!(error instanceof NotFoundError) || index === fields.length - 1) throw error;
        }
      }
      throw new NotFoundError(PROVIDER);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new OverseasTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'overseas-express', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
