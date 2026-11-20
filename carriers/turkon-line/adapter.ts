import type { AdapterEnvironment, AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { parseTurkon, PROVIDER, TURKON_MAX_BYTES, turkonQuery } from './parser.js';

export { containerCheckDigit, parseTurkon, turkonQuery } from './parser.js';

export const TURKON_ORIGIN = 'https://myturkonline.turkon.com';
/** The address the browser service knows a lookup by: it opens the tracking page and types the number. */
export const turkonPageUrl = (number: string): string => `${TURKON_ORIGIN}/tracking?${new URLSearchParams({ tracking: number })}`;
/** The containers' moves the page asks for once the number is searched. */
export const turkonLowerUrl = (number: string): string => `${TURKON_ORIGIN}/shipping-prod-service/tracking/getTrackingLowerInformation/en/${number}`;

export class TurkonTracker {
  constructor(private readonly environment: AdapterEnvironment) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const query = turkonQuery(raw);
    return runSteps({ carrier: PROVIDER, recorder: this.environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 75_000 + TRAWL_TRANSPORT_ALLOWANCE_MS }, [
      { id: 'trawl', run: ({ signal, remainingMs }) => this.browser(query, signal, remainingMs) },
    ]);
  }

  // Cloudflare checks every visitor of the tracker and its lookups, and the page takes a number
  // only from its search box, so the browser service searches and hands back that number's reply.
  private async browser(query: Parameters<typeof parseTurkon>[1], signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
    const trawl = this.environment.trawl;
    if (!trawl) throw new ChallengeError(PROVIDER, 'Turkon Line needs the browser tracking service');
    const url = turkonPageUrl(query.number), lower = turkonLowerUrl(query.number);
    const allowance = Math.min(TRAWL_TRANSPORT_ALLOWANCE_MS, Math.max(1000, Math.floor(remainingMs / 10)));
    const timeoutMs = Math.floor(Math.min(60_000, remainingMs - allowance));
    if (timeoutMs < 10_000) throw new BudgetExceededError(PROVIDER, remainingMs);
    try {
      const page = await trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
        captureResponses: [lower], settleTimeout: timeoutMs }, { provider: PROVIDER, timeoutMs, signal,
        fetcher: this.environment.fetcher, maxBytes: 4 * TURKON_MAX_BYTES, requireSolved: false, captureWindow: 'last' });
      signal.throwIfAborted();
      if (page.url !== url) throw new SchemaError(PROVIDER, 'Turkon Line left its tracking page');
      const replies = page.capturedResponses.filter(row => row.url === lower);
      if (replies.length > 2) throw new SchemaError(PROVIDER, 'Turkon Line returned too many tracking replies');
      if (replies.some(row => row.trackingNumberSubmitted !== query.number)) throw new SchemaError(PROVIDER, 'Turkon Line did not bind the whole tracking request');
      const row = replies.at(-1);
      if (row) {
        if ([401, 403, 428].includes(row.status) || row.error === 'challenge-html') {
          throw new ChallengeError(PROVIDER, 'Turkon Line refused browser verification', { status: row.status });
        }
        const retryAfter = retryAfterMs(Object.entries(row.headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1]);
        if (row.status === 429) throw new RateLimitedError(PROVIDER, retryAfter);
        if (row.status !== 200) throw new UpstreamHttpError(PROVIDER, row.status, retryAfter);
        if (row.error === 'invalid-json') throw new SchemaError(PROVIDER, 'Turkon Line returned invalid tracking JSON');
        if (row.error || row.truncated || row.base64Encoded || typeof row.body !== 'string'
          || new TextEncoder().encode(row.body).byteLength > TURKON_MAX_BYTES) throw new TransportError(PROVIDER, 'Turkon Line returned incomplete tracking data');
        return parseTurkon(row.body, query);
      }
      // Cloudflare's check in place of the page, never passed.
      if ([401, 403, 428].includes(page.statusCode)) throw new ChallengeError(PROVIDER, 'Turkon Line refused its tracking page', { status: page.statusCode });
      if (page.statusCode === 429) throw new RateLimitedError(PROVIDER);
      if (page.statusCode >= 400) throw new UpstreamHttpError(PROVIDER, page.statusCode);
      const timing: unknown = Array.isArray(page.raw.timings) ? page.raw.timings.at(-1) : undefined;
      const reason = isRecord(timing) && typeof timing.reason === 'string' ? timing.reason : '';
      if (reason === 'turkon-line-runtime') throw new TransportError(PROVIDER, 'Turkon Line could not open its tracking page');
      throw new TransportError(PROVIDER, 'Turkon Line did not capture its tracking reply');
    } catch (error) {
      // The outer browser-service request can contain the input or session state.
      if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
      if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
      throw error;
    }
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new TurkonTracker(environment);
  return { id: PROVIDER, steps: ['trawl'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context) };
};
