import type { AdapterEnvironment, AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS } from '../../core/transport/trawl.js';
import { MAX_BYTES, normalizeCostaRicaNumber, parseCostaRica, PROVIDER } from './parser.js';

export const COSTA_RICA_PAGE = 'https://sucursal.correos.go.cr/web/rastreo';
export const COSTA_RICA_POST = 'https://sucursal.correos.go.cr/web/trackingweb';
export const costaRicaUrl = (number: string): string => `${COSTA_RICA_PAGE}?${new URLSearchParams({ tracking: normalizeCostaRicaNumber(number) })}`;
export class CostaRicaTracker {
  constructor(private readonly environment: AdapterEnvironment) {}
  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted(); const number = normalizeCostaRicaNumber(raw), url = costaRicaUrl(number);
    return runSteps({ carrier: 'correos-costa-rica', recorder: this.environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 60_000 + TRAWL_TRANSPORT_ALLOWANCE_MS }, [{ id: 'trawl', run: async ({ signal, remainingMs }) => {
      if (!this.environment.trawl) throw new ChallengeError(PROVIDER, 'Correos needs the browser tracking service');
      const allowance = Math.min(TRAWL_TRANSPORT_ALLOWANCE_MS, Math.max(1000, Math.floor(remainingMs / 10)));
      const timeoutMs = Math.floor(Math.min(60_000, remainingMs - allowance));
      if (timeoutMs < 8000) throw new BudgetExceededError(PROVIDER, remainingMs);
      try {
        const page = await this.environment.trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
          captureResponses: [COSTA_RICA_POST], settleTimeout: timeoutMs }, { provider: PROVIDER, timeoutMs, signal,
          fetcher: this.environment.fetcher, requireSolved: false, captureWindow: 'last', maxBytes: 3 * MAX_BYTES });
        signal.throwIfAborted(); if (page.url !== url) throw new SchemaError(PROVIDER, 'Correos left its guest page');
        const rows = page.capturedResponses.filter(r => r.url === COSTA_RICA_POST);
        if (rows.length > 5) throw new SchemaError(PROVIDER, 'Correos returned too many replies');
        let result: CarrierResult | undefined, failure: Error | undefined;
        for (const row of rows) {
          result = undefined;
          if (row.trackingNumberSubmitted !== number) throw new SchemaError(PROVIDER, 'Correos did not bind the whole request');
          if (row.error || row.truncated || row.base64Encoded) { failure = new TransportError(PROVIDER, 'Correos tracking capture is incomplete'); continue; }
          if ([301,302,303,307,308].includes(row.status) && row.body === null) continue;
          if ([401,403,419,428].includes(row.status)) { failure = new ChallengeError(PROVIDER, 'Correos refused its guest form', { status: row.status }); continue; }
          if (row.status === 429) {
            const value = Object.entries(row.headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1];
            const delay = value && /^\d+$/.test(value) ? +value * 1000 : undefined;
            failure = new RateLimitedError(PROVIDER, delay); continue;
          }
          if (row.status !== 200) { failure = new UpstreamHttpError(PROVIDER, row.status); continue; }
          if (typeof row.body !== 'string' || new TextEncoder().encode(row.body).byteLength > MAX_BYTES) { failure = new TransportError(PROVIDER); continue; }
          let data: unknown; try { data = JSON.parse(row.body); } catch { throw new SchemaError(PROVIDER, 'Correos returned invalid tracking JSON'); }
          try { result = parseCostaRica(data, number); failure = undefined; }
          catch (error) { if (!(error instanceof Error) || error instanceof SchemaError) throw error; failure = error; }
        }
        if (result) return result; if (failure) throw failure;
        if (page.statusCode === 429) throw new RateLimitedError(PROVIDER);
        if ([401,403,419,428].includes(page.statusCode)) throw new ChallengeError(PROVIDER, 'Correos refused its guest page', { status: page.statusCode });
        if (page.statusCode >= 400) throw new UpstreamHttpError(PROVIDER, page.statusCode);
        throw new ChallengeError(PROVIDER, 'Correos did not complete guest verification');
      } catch (error) {
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
        if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
        throw error;
      }
    } }]);
  }
}
export const adapter: AdapterFactory = environment => {
  const tracker = new CostaRicaTracker(environment);
  return { id: 'correos-costa-rica', steps: ['trawl'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context) };
};
