import type { AdapterEnvironment, AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS } from '../../core/transport/trawl.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { MAX_BYTES, normalizeKuwaitPostNumber, parseKuwaitPost, PROVIDER } from './parser.js';

/** The tracker; its form posts to a Next.js server action at the page's own address. */
export const KUWAIT_POST_PAGE = 'https://moc.gov.kw/en/shipment-tracking';
/** The address the browser service knows a lookup by: the tracker with the whole item code after its hash. */
export const kuwaitPostUrl = (number: string): string => `${KUWAIT_POST_PAGE}#${normalizeKuwaitPostNumber(number)}`;

export class KuwaitPostTracker {
  constructor(private readonly environment: AdapterEnvironment) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeKuwaitPostNumber(raw), url = kuwaitPostUrl(number);
    return runSteps({ carrier: 'kuwait-post', recorder: this.environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 60_000 + TRAWL_TRANSPORT_ALLOWANCE_MS }, [{ id: 'trawl', run: async ({ signal, remainingMs }) => {
      // The tracker answers only after its reCAPTCHA checkbox: the browser service ticks it and sends the form.
      if (!this.environment.trawl) throw new ChallengeError(PROVIDER, 'Kuwait Post needs the browser tracking service');
      const allowance = Math.min(TRAWL_TRANSPORT_ALLOWANCE_MS, Math.max(1000, Math.floor(remainingMs / 10)));
      const timeoutMs = Math.floor(Math.min(60_000, remainingMs - allowance));
      if (timeoutMs < 10_000) throw new BudgetExceededError(PROVIDER, remainingMs);
      try {
        const page = await this.environment.trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
          captureResponses: [KUWAIT_POST_PAGE], settleTimeout: timeoutMs }, { provider: PROVIDER, timeoutMs, signal,
          fetcher: this.environment.fetcher, requireSolved: false, captureWindow: 'last', maxBytes: 3 * MAX_BYTES });
        signal.throwIfAborted();
        if (page.url !== url) throw new SchemaError(PROVIDER, 'Kuwait Post left its tracking page');
        const rows = page.capturedResponses.filter(r => r.url === KUWAIT_POST_PAGE);
        if (rows.length > 1) throw new SchemaError(PROVIDER, 'Kuwait Post returned more than one reply');
        const row = rows[0];
        if (row) {
          if (row.trackingNumberSubmitted !== number) throw new SchemaError(PROVIDER, 'Kuwait Post did not bind the whole request');
          if (row.error === 'challenge-html') throw new ChallengeError(PROVIDER, 'Kuwait Post answered with a block page');
          if (row.error || row.truncated || row.base64Encoded) throw new TransportError(PROVIDER, 'Kuwait Post tracking capture is incomplete');
          if ([401, 403, 419, 428].includes(row.status)) throw new ChallengeError(PROVIDER, 'Kuwait Post refused its tracking form', { status: row.status });
          if (row.status === 429) {
            const value = Object.entries(row.headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1];
            throw new RateLimitedError(PROVIDER, retryAfterMs(value, { dates: false }));
          }
          // The site answers 404 for an action id an earlier deployment gave the page: not the item's absence.
          if (row.status === 404 || row.status === 410) throw new TransportError(PROVIDER, 'Kuwait Post no longer knows its form\'s action');
          if (row.status !== 200) throw new UpstreamHttpError(PROVIDER, row.status);
          if (typeof row.body !== 'string' || new TextEncoder().encode(row.body).byteLength > MAX_BYTES) throw new TransportError(PROVIDER);
          let data: unknown; try { data = JSON.parse(row.body); } catch { throw new SchemaError(PROVIDER, 'Kuwait Post returned an invalid reply'); }
          return parseKuwaitPost(data, number);
        }
        if (page.statusCode === 429) throw new RateLimitedError(PROVIDER);
        if ([401, 403, 419, 428].includes(page.statusCode)) throw new ChallengeError(PROVIDER, 'Kuwait Post refused its tracking page', { status: page.statusCode });
        if (page.statusCode === 404 || page.statusCode === 410) throw new SchemaError(PROVIDER, 'Kuwait Post\'s tracking page is missing');
        if (page.statusCode >= 400) throw new UpstreamHttpError(PROVIDER, page.statusCode);
        throw new ChallengeError(PROVIDER, 'Kuwait Post did not complete its checkbox');
      } catch (error) {
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
        if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
        throw error;
      }
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new KuwaitPostTracker(environment);
  return { id: 'kuwait-post', steps: ['trawl'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context) };
};
