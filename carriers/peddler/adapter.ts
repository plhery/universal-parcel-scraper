import type { AdapterEnvironment, AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { MAX_BYTES, normalizePeddlerNumber, parsePeddler, PROVIDER } from './parser.js';

export const PEDDLER_ORIGIN = 'https://track.pdlr.nl';
/** The tracker's form with the number filled in. */
export const peddlerPageUrl = (number: string): string => `${PEDDLER_ORIGIN}/?${new URLSearchParams({ inquiryNumber: number })}`;
/** The data request the page sends for the number once its form passed verification. */
export const peddlerLoaderUrl = (number: string): string => `${PEDDLER_ORIGIN}/trackntrace/${number}?_data=routes%2Ftrackntrace.%24inquiryNumber`;

export class PeddlerTracker {
  constructor(private readonly environment: AdapterEnvironment) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizePeddlerNumber(raw);
    return runSteps({ carrier: 'peddler', recorder: this.environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 60_000 + TRAWL_TRANSPORT_ALLOWANCE_MS }, [
      { id: 'trawl', run: ({ signal, remainingMs }) => this.browser(number, signal, remainingMs) },
    ]);
  }

  // Every lookup passes the form's Turnstile, whose cookie the tracker binds to one number, so the
  // page itself submits and the browser service hands back only that number's data reply.
  private async browser(number: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
    const trawl = this.environment.trawl;
    if (!trawl) throw new ChallengeError(PROVIDER, 'Peddler needs the browser tracking service');
    const url = peddlerPageUrl(number), loader = peddlerLoaderUrl(number);
    const allowance = Math.min(TRAWL_TRANSPORT_ALLOWANCE_MS, Math.max(1000, Math.floor(remainingMs / 10)));
    const timeoutMs = Math.floor(Math.min(60_000, remainingMs - allowance));
    if (timeoutMs < 8000) throw new BudgetExceededError(PROVIDER, remainingMs);
    try {
      const page = await trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
        captureResponses: [loader], settleTimeout: timeoutMs }, { provider: PROVIDER, timeoutMs, signal,
        fetcher: this.environment.fetcher, maxBytes: 4 * MAX_BYTES, requireSolved: false, captureWindow: 'last' });
      signal.throwIfAborted();
      if (page.url !== url) throw new SchemaError(PROVIDER, 'Peddler left its tracking page');
      const replies = page.capturedResponses.filter(row => row.url === loader);
      if (replies.length > 2) throw new SchemaError(PROVIDER, 'Peddler returned too many tracking replies');
      if (replies.some(row => row.trackingNumberSubmitted !== number)) throw new SchemaError(PROVIDER, 'Peddler did not bind the whole tracking request');
      const row = replies.at(-1);
      if (row) {
        if ([401, 403, 428].includes(row.status) || row.error === 'challenge-html') throw new ChallengeError(PROVIDER, 'Peddler refused guest verification', { status: row.status });
        const retry = Object.entries(row.headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1];
        const ms = retry === undefined ? NaN : /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
        const retryAfterMs = Number.isFinite(ms) ? Math.max(0, ms) : undefined;
        if (row.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs);
        // An unknown number's data reply is a 404 that says so; any other status is not an answer.
        if (![200, 404].includes(row.status)) throw new UpstreamHttpError(PROVIDER, row.status, retryAfterMs);
        if (row.error === 'invalid-json') throw new SchemaError(PROVIDER, 'Peddler returned invalid tracking JSON');
        if (row.error || row.truncated || row.base64Encoded || typeof row.body !== 'string'
          || new TextEncoder().encode(row.body).byteLength > MAX_BYTES) throw new TransportError(PROVIDER, 'Peddler returned incomplete tracking data');
        let data: unknown; try { data = JSON.parse(row.body); } catch { throw new SchemaError(PROVIDER, 'Peddler returned invalid tracking JSON'); }
        if (row.status === 404 && !(isRecord(data) && typeof data.error === 'string')) throw new UpstreamHttpError(PROVIDER, 404);
        return parsePeddler(data, number);
      }
      if ([401, 403, 428].includes(page.statusCode)) throw new ChallengeError(PROVIDER, 'Peddler refused its tracking page', { status: page.statusCode });
      if (page.statusCode === 429) throw new RateLimitedError(PROVIDER);
      if (page.statusCode >= 400) throw new UpstreamHttpError(PROVIDER, page.statusCode);
      const timing: unknown = Array.isArray(page.raw.timings) ? page.raw.timings.at(-1) : undefined;
      const reason = isRecord(timing) && typeof timing.reason === 'string' ? timing.reason : '';
      if (['peddler-runtime', 'peddler-capture_missing'].includes(reason)) throw new TransportError(PROVIDER, 'Peddler could not capture its tracking reply');
      if (reason === 'peddler-verification_refused') throw new ChallengeError(PROVIDER, 'Peddler refused guest verification', { reason: 'verification_refused' });
      throw new ChallengeError(PROVIDER, 'Peddler did not finish browser verification', { reason: 'verification_unfinished' });
    } catch (error) {
      // The outer browser-service request can contain the input or session state.
      if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
      if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
      throw error;
    }
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new PeddlerTracker(environment);
  return { id: 'peddler', steps: ['trawl'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context) };
};
