import type { AdapterEnvironment, AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError,
  UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS } from '../../core/transport/trawl.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { isRecord } from '../../core/types.js';
import { MAX_BYTES, normalizeTransglobalReference, parseTransglobal, PROVIDER } from './parser.js';

export { normalizeTransglobalReference, parseTransglobal } from './parser.js';

export const TRANSGLOBAL_ORIGIN = 'https://www.transglobalexpress.co.uk';
/** The address the browser service is asked for: the tracking form, with the whole reference to type into it. */
export const transglobalPageUrl = (reference: string): string => `${TRANSGLOBAL_ORIGIN}/track-shipment/?${new URLSearchParams({ reference })}`;
/** The result page the form sends a reference it knows to. */
export const transglobalResultUrl = (): string => `${TRANSGLOBAL_ORIGIN}/Tracking/TrackShipmentNEW/`;

export class TransglobalTracker {
  constructor(private readonly environment: AdapterEnvironment) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const reference = normalizeTransglobalReference(raw);
    return runSteps({ carrier: PROVIDER, recorder: this.environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 60_000 + TRAWL_TRANSPORT_ALLOWANCE_MS }, [
      { id: 'trawl', run: ({ signal, remainingMs }) => this.browser(reference, signal, remainingMs) },
    ]);
  }

  // Cloudflare guards the form and every page under /Tracking/, so the browser service posts the
  // form and hands back only the result page of that order, read down to its legs and rows.
  private async browser(reference: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
    const trawl = this.environment.trawl;
    if (!trawl) throw new ChallengeError(PROVIDER, 'Transglobal Express needs the browser tracking service');
    const url = transglobalPageUrl(reference), result = transglobalResultUrl();
    const allowance = Math.min(TRAWL_TRANSPORT_ALLOWANCE_MS, Math.max(1000, Math.floor(remainingMs / 10)));
    const timeoutMs = Math.floor(Math.min(45_000, remainingMs - allowance));
    if (timeoutMs < 8000) throw new BudgetExceededError(PROVIDER, remainingMs);
    try {
      const page = await trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
        captureResponses: [result], settleTimeout: timeoutMs }, { provider: PROVIDER, timeoutMs, signal,
        fetcher: this.environment.fetcher, maxBytes: 4 * MAX_BYTES, requireSolved: false, captureWindow: 'last' });
      signal.throwIfAborted();
      if (page.url !== url) throw new SchemaError(PROVIDER, 'Transglobal Express left its tracking form');
      const replies = page.capturedResponses.filter((row) => row.url === result);
      if (replies.length > 1) throw new SchemaError(PROVIDER, 'Transglobal Express returned too many tracking pages');
      // The helper reports the reference without its hyphen, as the client keeps a bound number.
      if (replies.some((row) => row.trackingNumberSubmitted !== reference.replace('-', ''))) {
        throw new SchemaError(PROVIDER, 'Transglobal Express did not bind the whole reference');
      }
      const timing: unknown = Array.isArray(page.raw.timings) ? page.raw.timings.at(-1) : undefined;
      const reason = isRecord(timing) && typeof timing.reason === 'string' ? timing.reason : '';
      const row = replies[0];
      if (row) {
        if ([401, 403, 428].includes(row.status) || row.error === 'challenge-html') {
          throw new ChallengeError(PROVIDER, 'Transglobal Express refused the browser', { status: row.status });
        }
        // The form sent the reference to another order's page, or away from its result page.
        if (row.error === 'unexpected-redirect') throw new IndeterminateError(PROVIDER, 'Transglobal Express sent the reference to another page');
        const retryAfter = retryAfterMs(Object.entries(row.headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1]);
        if (row.status === 429) throw new RateLimitedError(PROVIDER, retryAfter);
        if (row.status !== 200) throw new UpstreamHttpError(PROVIDER, row.status, retryAfter);
        if (row.error || row.truncated || row.base64Encoded || typeof row.body !== 'string'
          || new TextEncoder().encode(row.body).byteLength > MAX_BYTES) {
          throw new TransportError(PROVIDER, 'Transglobal Express returned an incomplete tracking page');
        }
        let data: unknown; try { data = JSON.parse(row.body); } catch { throw new SchemaError(PROVIDER, 'Transglobal Express returned an unreadable answer'); }
        return parseTransglobal(data);
      }
      if ([401, 403, 428].includes(page.statusCode) || reason === 'transglobal-verification') {
        throw new ChallengeError(PROVIDER, 'Transglobal Express refused its tracking form', { status: page.statusCode });
      }
      if (page.statusCode === 429) throw new RateLimitedError(PROVIDER);
      if (page.statusCode >= 400) throw new UpstreamHttpError(PROVIDER, page.statusCode);
      if (reason === 'transglobal-runtime') throw new TransportError(PROVIDER, 'Transglobal Express could not open its tracking form');
      throw new TransportError(PROVIDER, 'Transglobal Express did not capture its tracking page');
    } catch (error) {
      // The outer browser-service request can contain the input or session state.
      if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
      if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
      throw error;
    }
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TransglobalTracker(environment);
  return { id: PROVIDER, steps: ['trawl'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context) };
};
