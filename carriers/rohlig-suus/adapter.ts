import type { AdapterEnvironment, AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, NotFoundError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { MAX_BYTES, normalizeRohligSuusNumber, parseRohligSuus, PROVIDER } from './parser.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';

export const ROHLIG_SUUS_ORIGIN = 'https://portal.suus.com';
/** The guest order page for one number. */
export const rohligSuusPageUrl = (number: string): string => `${ROHLIG_SUUS_ORIGIN}/order-details/${number}`;
/** The lookup the page sends for the number with its reCAPTCHA token. */
export const rohligSuusOrdersUrl = (number: string): string =>
  `${ROHLIG_SUUS_ORIGIN}/api/parcel/guest/tracking/orders?${new URLSearchParams({ parcelNumber: number, locale: 'en' })}`;

export class RohligSuusTracker {
  constructor(private readonly environment: AdapterEnvironment) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeRohligSuusNumber(raw);
    return runSteps({ carrier: 'rohlig-suus', recorder: this.environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 60_000 + TRAWL_TRANSPORT_ALLOWANCE_MS }, [
      { id: 'trawl', run: ({ signal, remainingMs }) => this.browser(number, signal, remainingMs) },
    ]);
  }

  // Every lookup carries a reCAPTCHA Enterprise token, which the order page gets for itself, so the
  // page asks and the browser service hands back only that number's reply.
  private async browser(number: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
    const trawl = this.environment.trawl;
    if (!trawl) throw new ChallengeError(PROVIDER, 'Rohlig SUUS Logistics needs the browser tracking service');
    const url = rohligSuusPageUrl(number), orders = rohligSuusOrdersUrl(number);
    const allowance = Math.min(TRAWL_TRANSPORT_ALLOWANCE_MS, Math.max(1000, Math.floor(remainingMs / 10)));
    const timeoutMs = Math.floor(Math.min(45_000, remainingMs - allowance));
    if (timeoutMs < 8000) throw new BudgetExceededError(PROVIDER, remainingMs);
    try {
      const page = await trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
        captureResponses: [orders], settleTimeout: timeoutMs }, { provider: PROVIDER, timeoutMs, signal,
        fetcher: this.environment.fetcher, maxBytes: 4 * MAX_BYTES, requireSolved: false, captureWindow: 'last' });
      signal.throwIfAborted();
      if (page.url !== url) throw new SchemaError(PROVIDER, 'Rohlig SUUS Logistics left its order page');
      const replies = page.capturedResponses.filter(row => row.url === orders);
      if (replies.length > 2) throw new SchemaError(PROVIDER, 'Rohlig SUUS Logistics returned too many tracking replies');
      if (replies.some(row => row.trackingNumberSubmitted !== number)) throw new SchemaError(PROVIDER, 'Rohlig SUUS Logistics did not bind the whole tracking request');
      const row = replies.at(-1);
      if (row) {
        // The tracker answers a missing token with an empty 500, and one reCAPTCHA scores too low with a 400 the helper marks.
        if ([401, 403, 428].includes(row.status) || row.error === 'challenge-html' || row.error === 'recaptcha-refused'
          || (row.status === 500 && !row.body)) {
          throw new ChallengeError(PROVIDER, 'Rohlig SUUS Logistics refused guest verification', { status: row.status });
        }
        const retryAfter = retryAfterMs(Object.entries(row.headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1]);
        if (row.status === 429) throw new RateLimitedError(PROVIDER, retryAfter);
        // A number the tracker does not know answers 204 with nothing in it.
        if (row.status === 204 && !row.body) throw new NotFoundError(PROVIDER);
        if (row.status !== 200) throw new UpstreamHttpError(PROVIDER, row.status, retryAfter);
        if (row.error === 'invalid-json') throw new SchemaError(PROVIDER, 'Rohlig SUUS Logistics returned invalid tracking JSON');
        if (row.error || row.truncated || row.base64Encoded || typeof row.body !== 'string'
          || new TextEncoder().encode(row.body).byteLength > MAX_BYTES) throw new TransportError(PROVIDER, 'Rohlig SUUS Logistics returned incomplete tracking data');
        let data: unknown; try { data = JSON.parse(row.body); } catch { throw new SchemaError(PROVIDER, 'Rohlig SUUS Logistics returned invalid tracking JSON'); }
        return parseRohligSuus(data, number);
      }
      if ([401, 403, 428].includes(page.statusCode)) throw new ChallengeError(PROVIDER, 'Rohlig SUUS Logistics refused its order page', { status: page.statusCode });
      if (page.statusCode === 429) throw new RateLimitedError(PROVIDER);
      if (page.statusCode >= 400) throw new UpstreamHttpError(PROVIDER, page.statusCode);
      const timing: unknown = Array.isArray(page.raw.timings) ? page.raw.timings.at(-1) : undefined;
      const reason = isRecord(timing) && typeof timing.reason === 'string' ? timing.reason : '';
      if (reason === 'rohlig-suus-runtime') throw new TransportError(PROVIDER, 'Rohlig SUUS Logistics could not open its order page');
      throw new TransportError(PROVIDER, 'Rohlig SUUS Logistics did not capture its tracking reply');
    } catch (error) {
      // The outer browser-service request can contain the input or session state.
      if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
      if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
      throw error;
    }
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new RohligSuusTracker(environment);
  return { id: 'rohlig-suus', steps: ['trawl'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context) };
};
