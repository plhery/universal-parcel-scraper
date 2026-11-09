import { type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, NotFoundError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { trawlPrivateScrape } from '../../core/transport/trawlPrivate.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { AEROPOST_API, AEROPOST_MAX_BYTES, normalizeAeropostNumber, parseAeropost, PROVIDER } from './parser.js';

function failure(status: number, retryAfter?: string): Error {
  if ([400, 401, 403].includes(status)) return new ChallengeError(PROVIDER, 'Aeropost did not accept browser verification');
  if (!status) return new TransportError(PROVIDER, 'Aeropost browser tracking did not finish');
  const wait = retryAfter === undefined ? NaN : /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
  return new UpstreamHttpError(PROVIDER, status, Number.isFinite(wait) ? Math.max(0, wait) : undefined);
}

export class AeropostTracker {
  constructor(private readonly options: { trawl?: TrawlClient | null; fetcher?: typeof fetch; recorder?: StepRecorder } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAeropostNumber(raw);
    return runSteps({ carrier: 'aeropost', budgetMs: context.budgetMs ?? 45_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'trawl', run: async ({ signal, remainingMs }) => {
      if (!this.options.trawl) throw new ChallengeError(PROVIDER, 'Aeropost requires the browser tracking service');
      const timeoutMs = Math.floor(Math.min(30_000, remainingMs - TRAWL_TRANSPORT_ALLOWANCE_MS));
      if (timeoutMs < 2000) throw new BudgetExceededError(PROVIDER, remainingMs);
      const url = `https://aeropost.com/en/tracking/${number}`;
      const page = await trawlPrivateScrape(this.options.trawl, { url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
        captureResponses: [AEROPOST_API] }, { provider: 'TRAWL while fetching Aeropost', timeoutMs, signal,
        fetcher: this.options.fetcher, maxBytes: 3 * AEROPOST_MAX_BYTES, requireSolved: false, captureWindow: 'last' });
      signal.throwIfAborted();
      if (page.url !== url || typeof page.raw.effectiveUrl === 'string' && page.raw.effectiveUrl !== url) throw new SchemaError(PROVIDER, 'Aeropost left its tracking page');
      let result: CarrierResult | undefined, error: Error | undefined;
      for (const entry of page.capturedResponses.filter(entry => entry.url === AEROPOST_API)) {
        if (!entry.trackingNumberSubmitted) throw new TransportError(PROVIDER, 'The browser service does not support bound Aeropost tracking');
        if (entry.trackingNumberSubmitted !== number) throw new SchemaError(PROVIDER, 'The browser service did not bind the whole Aeropost request');
        result = undefined;
        if (!entry.status) { error = failure(0); continue; }
        if (entry.truncated || entry.error || entry.base64Encoded) throw new SchemaError(PROVIDER, 'Aeropost returned unreadable tracking data');
        if (![200, 404].includes(entry.status)) { error = failure(entry.status, entry.headers['retry-after']); continue; }
        if (typeof entry.body !== 'string' || new TextEncoder().encode(entry.body).byteLength > AEROPOST_MAX_BYTES) throw new SchemaError(PROVIDER, 'Aeropost returned no readable tracking reply');
        let payload: unknown;
        try { payload = JSON.parse(entry.body); } catch { throw new SchemaError(PROVIDER, 'Aeropost returned invalid tracking JSON'); }
        if (entry.status === 404) {
          if (!isRecord(payload) || payload.statusCode !== 404 || payload.statusMessage !== 'Tracking information not found') throw new TransportError(PROVIDER, 'Aeropost tracking endpoint is unavailable');
          error = new NotFoundError(PROVIDER); continue;
        }
        result = parseAeropost(payload); error = undefined;
      }
      if (result) return result;
      if (error) throw error;
      if (page.statusCode !== 200) throw failure(page.statusCode);
      throw new ChallengeError(PROVIDER, 'Aeropost sent no verified tracking response');
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new AeropostTracker({ trawl: environment.trawl, fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'aeropost', recordsSteps: true, steps: ['trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
