import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { CarrierError, carrierErrorKind, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from '../../core/transport/trawl.js';
import { isDpdUkReferenceAbsent, normalizeDpdUkNumber, parseDpdUkHistory, parseDpdUkReference, PROVIDER, validateDpdUkParcel } from './parser.js';
import { DPD_UK_BROWSER_MIN_MS, dpdUkRefusal, readDpdUkTrawl, type DpdUkStage } from './trawl.js';

const API = 'https://apis.track.dpd.co.uk/v1';

export class DpdUkTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeDpdUkNumber(raw);
    const trawl = this.options.trawl;
    return runSteps({ carrier: 'dpd-uk', signal: context.signal, budgetMs: context.budgetMs ?? (trawl ? 45_000 : 15_000),
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.direct(number, signal, remainingMs) },
      // DPD UK's API sometimes refuses its reads outright; its own page in a browser may still be let through.
      // Its 429 blocks the whole address, which the browser service shares, so a rate limit ends the lookup.
      { id: 'trawl', enabled: Boolean(trawl), recovers: error => carrierErrorKind(error) === 'challenge',
        run: ({ signal, remainingMs, previousError }) => {
          if (remainingMs < TRAWL_TRANSPORT_ALLOWANCE_MS + DPD_UK_BROWSER_MIN_MS) throw previousError;
          return readDpdUkTrawl(number, trawl!, { fetcher: this.options.fetcher, signal, remainingMs });
        } },
    ]);
  }

  private async direct(number: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + remainingMs;
    const read = async (stage: DpdUkStage, path: string): Promise<unknown> => {
      let refusal: CarrierError | undefined;
      try {
        signal.throwIfAborted();
        const { bytes, response } = await fetchBounded(`${API}${path}`, { signal, headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } },
          { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxBytes: 1_000_000,
            fetcher: this.options.fetcher, allowHttpStatuses: [401, 403, 404, 410] });
        if (response.status === 401 || response.status === 403) {
          refusal = dpdUkRefusal(stage, response.status, decodeText(bytes));
          throw refusal;
        }
        let payload: unknown;
        try { payload = parseJsonBytes(bytes, PROVIDER); }
        catch { throw response.ok ? new SchemaError(PROVIDER) : new TransportError(PROVIDER, 'DPD UK tracking endpoint is unavailable'); }
        if (!response.ok) {
          if (stage === 'reference search' && response.status === 404 && isDpdUkReferenceAbsent(payload)) throw new NotFoundError(PROVIDER);
          throw new TransportError(PROVIDER, 'DPD UK tracking endpoint is unavailable');
        }
        return payload;
      } catch (error) {
        signal.throwIfAborted();
        if (error === refusal) throw error;
        // Request diagnostics and malformed bodies can contain an issued parcel
        // handle or personal details. Keep the classification, never its cause.
        if (error instanceof CarrierError) throw new CarrierError(error.kind, PROVIDER, `${PROVIDER} tracking failed (${error.kind})`,
          { status: error.status, retryAfterMs: error.retryAfterMs, reason: error.reason });
        throw new TransportError(PROVIDER);
      }
    };
    const query = new URLSearchParams({ origin: 'PRTK', postcode: '', referenceNumber: number });
    const code = parseDpdUkReference(await read('reference search', `/reference?${query}`), number);
    const parcelPath = `/parcels/${encodeURIComponent(code)}`;
    const detail = await read('parcel detail', parcelPath);
    validateDpdUkParcel(detail, number, code);
    const history = await read('parcel events', `${parcelPath}/parcelevents`);
    return parseDpdUkHistory(detail, history, number, code);
  }
}

export const adapter: AdapterFactory = environment => {
  const options = { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent };
  const tracker = new DpdUkTracker({ ...options, trawl: environment.trawl });
  // Recognition stays on HTTP and never opens a browser.
  const recognition = new DpdUkTracker(options);
  return { id: 'dpd-uk', recordsSteps: true, steps: ['direct', 'trawl'], track: (input, context) => tracker.fetch(input.number, context),
    // The reference service names a number it does not know, so the lookup answers recognition.
    recognize: (number, context) => recognizeFromLookup(() => recognition.fetch(number, context), () => accepted(() => normalizeDpdUkNumber(number))) };
};
