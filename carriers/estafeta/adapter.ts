import { recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { estafetaRegistered, normalizeEstafetaNumber, parseEstafetaHistory, parseEstafetaLookup } from './parser.js';

const ORIGIN = 'https://cs.estafeta.com';

export class EstafetaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}
  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeEstafetaNumber(raw);
    const budgetMs = context.budgetMs ?? 15_000;
    return runSteps({ carrier: 'estafeta', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER },
      [{ id: 'direct', run: async ({ signal, remainingMs }) => {
        const started = performance.now();
        const timeout = () => {
          signal.throwIfAborted();
          const left = remainingMs - (performance.now() - started);
          if (left <= 0) throw new BudgetExceededError('Estafeta', budgetMs);
          return Math.max(1, Math.floor(left));
        };
        try {
          const params = new URLSearchParams({ wayBill: number, wayBillType: number.length === 10 ? '0' : '1', isShipmentDetail: 'True' });
          const first = await fetchBounded(`${ORIGIN}/es/Tracking/searchByGet?${params}`, { signal, headers: { 'User-Agent': userAgentOf(this.options.userAgent) } },
            { provider: 'Estafeta', timeoutMs: timeout(), maxBytes: 1_000_000, fetcher: this.options.fetcher });
          const lookup = parseEstafetaLookup(decodeText(first.bytes), number);
          if (lookup.registered) return estafetaRegistered(lookup);
          // Only the identity-bound canonical guide controls this read-only
          // history request. No account, issued session or report API is used.
          const history = await fetchBounded(`${ORIGIN}/es/Tracking/GetTrackingItemHistory`, { method: 'POST', signal,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgentOf(this.options.userAgent) }, body: new URLSearchParams({ waybill: lookup.guide }).toString() },
            { provider: 'Estafeta', timeoutMs: timeout(), maxBytes: 1_000_000, fetcher: this.options.fetcher });
          return parseEstafetaHistory(decodeText(history.bytes), lookup);
        } catch (error) {
          if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) throw new TransportError('Estafeta', 'Estafeta tracking endpoint is unavailable', { cause: error });
          throw error;
        }
      } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new EstafetaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'estafeta', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    // A number Estafeta does not hold gets its generic page, which proves nothing: recognition can only confirm.
    recognize: async (number, context) => {
      let registered = false;
      const answer = await recognizeFromLookup(async () => {
        const result = await tracker.fetch(number, context);
        registered = result.current_stage === 'registered';
        return result;
      });
      // A label Estafeta has not yet received is a notice bound to the parcel's own guide, unlike the
      // pending answer some carriers give any number: Estafeta holds the number.
      return registered && !answer.known ? { known: true, lastActivityAt: null } : answer;
    } };
};
