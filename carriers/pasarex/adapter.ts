import type { AdapterEnvironment, AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS } from '../../core/transport/trawl.js';
import { MAX_BYTES, normalizePasarexNumber, parsePasarex, PROVIDER } from './parser.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';

export const PASAREX_PAGE = 'https://tracking.pasarex.com/';
export const PASAREX_RESULT = 'https://tracking.pasarex.com/tracking';
export const pasarexUrl = (number: string): string => `${PASAREX_PAGE}?${new URLSearchParams({ awb: normalizePasarexNumber(number) })}`;

export class PasarexTracker {
  constructor(private readonly environment: AdapterEnvironment) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizePasarexNumber(raw), url = pasarexUrl(number);
    return runSteps({ carrier: 'pasarex', recorder: this.environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 60_000 + TRAWL_TRANSPORT_ALLOWANCE_MS }, [{ id: 'trawl', run: async ({ signal, remainingMs }) => {
      // The tracker answers only after its reCAPTCHA checkbox: the browser service ticks it and sends the form.
      if (!this.environment.trawl) throw new ChallengeError(PROVIDER, 'PasarEX needs the browser tracking service');
      const allowance = Math.min(TRAWL_TRANSPORT_ALLOWANCE_MS, Math.max(1000, Math.floor(remainingMs / 10)));
      const timeoutMs = Math.floor(Math.min(60_000, remainingMs - allowance));
      if (timeoutMs < 8000) throw new BudgetExceededError(PROVIDER, remainingMs);
      try {
        const page = await this.environment.trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
          captureResponses: [PASAREX_RESULT], settleTimeout: timeoutMs }, { provider: PROVIDER, timeoutMs, signal,
          fetcher: this.environment.fetcher, requireSolved: false, captureWindow: 'last', maxBytes: 3 * MAX_BYTES });
        signal.throwIfAborted();
        if (page.url !== url) throw new SchemaError(PROVIDER, 'PasarEX left its tracking page');
        const rows = page.capturedResponses.filter(r => r.url === PASAREX_RESULT);
        if (rows.length > 5) throw new SchemaError(PROVIDER, 'PasarEX returned too many replies');
        let result: CarrierResult | undefined, failure: Error | undefined;
        for (const row of rows) {
          result = undefined;
          if (row.trackingNumberSubmitted !== number) throw new SchemaError(PROVIDER, 'PasarEX did not bind the whole request');
          if (row.error || row.truncated || row.base64Encoded) { failure = new TransportError(PROVIDER, 'PasarEX tracking capture is incomplete'); continue; }
          if ([401, 403, 419, 428].includes(row.status)) { failure = new ChallengeError(PROVIDER, 'PasarEX refused its tracking form', { status: row.status }); continue; }
          if (row.status === 429) {
            const value = Object.entries(row.headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1];
            failure = new RateLimitedError(PROVIDER, retryAfterMs(value, { dates: false })); continue;
          }
          if (row.status !== 200) { failure = new UpstreamHttpError(PROVIDER, row.status); continue; }
          if (typeof row.body !== 'string' || new TextEncoder().encode(row.body).byteLength > MAX_BYTES) { failure = new TransportError(PROVIDER); continue; }
          let data: unknown; try { data = JSON.parse(row.body); } catch { throw new SchemaError(PROVIDER, 'PasarEX returned invalid tracking JSON'); }
          try { result = parsePasarex(data, number); failure = undefined; }
          catch (error) { if (!(error instanceof Error) || error instanceof SchemaError) throw error; failure = error; }
        }
        if (result) return result;
        if (failure) throw failure;
        if (page.statusCode === 429) throw new RateLimitedError(PROVIDER);
        if ([401, 403, 419, 428].includes(page.statusCode)) throw new ChallengeError(PROVIDER, 'PasarEX refused its tracking page', { status: page.statusCode });
        if (page.statusCode >= 400) throw new UpstreamHttpError(PROVIDER, page.statusCode);
        throw new ChallengeError(PROVIDER, 'PasarEX did not complete its checkbox');
      } catch (error) {
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
        if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
        throw error;
      }
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new PasarexTracker(environment);
  return { id: 'pasarex', steps: ['trawl'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context) };
};
