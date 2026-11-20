import type { AdapterEnvironment, AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { HAPAG_MAX_BYTES, hapagQuery, hapagRefusal, parseHapag, PROVIDER, type HapagQuery } from './parser.js';

export { containerCheckDigit, hapagQuery, parseHapag } from './parser.js';

/** The address the browser service knows a lookup by: the tracking page with the reference in its route. */
export const hapagPageUrl = (reference: string): string => `https://www.hapag-lloyd.com/solutions/tracking/#/${reference}`;
/** The containers' moves the page asks for once its Turnstile has passed. */
export const hapagEventsUrl = (reference: string): string =>
  `https://tracking.api.hlag.cloud/api/tracking/v3/events?${new URLSearchParams({ reference })}`;

export class HapagTracker {
  constructor(private readonly environment: AdapterEnvironment) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const query = hapagQuery(raw);
    return runSteps({ carrier: PROVIDER, recorder: this.environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 75_000 + TRAWL_TRANSPORT_ALLOWANCE_MS }, [
      { id: 'trawl', run: ({ signal, remainingMs }) => this.browser(query, signal, remainingMs) },
    ]);
  }

  // Cloudflare checks every visitor of the tracking page, and its lookup needs a token from the
  // page's own Turnstile, so the browser service opens the page and hands back that lookup's reply.
  private async browser(query: HapagQuery, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
    const trawl = this.environment.trawl;
    if (!trawl) throw new ChallengeError(PROVIDER, 'Hapag-Lloyd needs the browser tracking service');
    const url = hapagPageUrl(query.reference), events = hapagEventsUrl(query.reference);
    const allowance = Math.min(TRAWL_TRANSPORT_ALLOWANCE_MS, Math.max(1000, Math.floor(remainingMs / 10)));
    const timeoutMs = Math.floor(Math.min(60_000, remainingMs - allowance));
    if (timeoutMs < 10_000) throw new BudgetExceededError(PROVIDER, remainingMs);
    try {
      const page = await trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
        captureResponses: [events], settleTimeout: timeoutMs }, { provider: PROVIDER, timeoutMs, signal,
        fetcher: this.environment.fetcher, maxBytes: 4 * HAPAG_MAX_BYTES, requireSolved: false, captureWindow: 'last' });
      signal.throwIfAborted();
      if (page.url !== url) throw new SchemaError(PROVIDER, 'Hapag-Lloyd left its tracking page');
      const replies = page.capturedResponses.filter(row => row.url === events);
      if (replies.length > 2) throw new SchemaError(PROVIDER, 'Hapag-Lloyd returned too many tracking replies');
      if (replies.some(row => row.trackingNumberSubmitted !== query.reference)) throw new SchemaError(PROVIDER, 'Hapag-Lloyd did not bind the whole tracking request');
      const row = replies.at(-1);
      if (row) {
        if (row.error === 'challenge-html') throw new ChallengeError(PROVIDER, 'Hapag-Lloyd refused browser verification', { status: row.status });
        if (row.error === 'invalid-json') throw new SchemaError(PROVIDER, 'Hapag-Lloyd returned invalid tracking JSON');
        if (row.error || row.truncated || row.base64Encoded || typeof row.body !== 'string'
          || new TextEncoder().encode(row.body).byteLength > HAPAG_MAX_BYTES) throw new TransportError(PROVIDER, 'Hapag-Lloyd returned incomplete tracking data');
        // The tracker answers a reference it does not hold with a not-found error key.
        // A refusal without a key it knows, or a missing address, does not say the reference is unknown.
        if (row.status === 422 || row.status === 404) {
          throw hapagRefusal(row.body) ?? new IndeterminateError(PROVIDER, `Hapag-Lloyd refused the lookup with HTTP ${row.status}`, { status: row.status });
        }
        // Without a token from the page's Turnstile the lookup is refused.
        if ([401, 403, 428].includes(row.status)) throw new ChallengeError(PROVIDER, 'Hapag-Lloyd refused browser verification', { status: row.status });
        const retryAfter = retryAfterMs(Object.entries(row.headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1]);
        if (row.status === 429) throw new RateLimitedError(PROVIDER, retryAfter);
        if (row.status !== 200) throw new UpstreamHttpError(PROVIDER, row.status, retryAfter);
        return parseHapag(row.body, query);
      }
      // Cloudflare's check in place of the page, never passed.
      if ([401, 403, 428].includes(page.statusCode)) throw new ChallengeError(PROVIDER, 'Hapag-Lloyd refused its tracking page', { status: page.statusCode });
      if (page.statusCode === 429) throw new RateLimitedError(PROVIDER);
      if (page.statusCode >= 400) throw new UpstreamHttpError(PROVIDER, page.statusCode);
      const timing: unknown = Array.isArray(page.raw.timings) ? page.raw.timings.at(-1) : undefined;
      const reason = isRecord(timing) && typeof timing.reason === 'string' ? timing.reason : '';
      if (reason === 'hapag-lloyd-runtime') throw new TransportError(PROVIDER, 'Hapag-Lloyd could not open its tracking page');
      throw new TransportError(PROVIDER, 'Hapag-Lloyd did not capture its tracking reply');
    } catch (error) {
      // The outer browser-service request can contain the input or session state.
      if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
      if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
      throw error;
    }
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new HapagTracker(environment);
  return { id: PROVIDER, steps: ['trawl'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context) };
};
