import type { AdapterEnvironment, AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { MAX_BYTES, normalizeOnexNumber, parseOnex, PROVIDER } from './parser.js';

export const ONEX_ORIGIN = 'https://onex.am';
/** The English tracker, which submits the number in its address itself. */
export const onexPageUrl = (number: string): string => `${ONEX_ORIGIN}/en/onextrack?${new URLSearchParams({ track: number })}`;
/** The lookup the page posts the number to. */
export const onexLookupUrl = (): string => `${ONEX_ORIGIN}/en/onextrack/findtrackingcodeimport`;

export class OnexTracker {
  constructor(private readonly environment: AdapterEnvironment) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeOnexNumber(raw);
    return runSteps({ carrier: 'onex', recorder: this.environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 60_000 + TRAWL_TRANSPORT_ALLOWANCE_MS }, [
      { id: 'trawl', run: ({ signal, remainingMs }) => this.browser(number, signal, remainingMs) },
    ]);
  }

  // Cloudflare challenges the tracker and its lookup, so the page loads in the browser service, posts
  // the number itself, and the service hands back only that number's reply.
  private async browser(number: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
    const trawl = this.environment.trawl;
    if (!trawl) throw new ChallengeError(PROVIDER, 'Onex needs the browser tracking service');
    const url = onexPageUrl(number), lookup = onexLookupUrl();
    const allowance = Math.min(TRAWL_TRANSPORT_ALLOWANCE_MS, Math.max(1000, Math.floor(remainingMs / 10)));
    const timeoutMs = Math.floor(Math.min(45_000, remainingMs - allowance));
    if (timeoutMs < 8000) throw new BudgetExceededError(PROVIDER, remainingMs);
    try {
      const page = await trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
        captureResponses: [lookup], settleTimeout: timeoutMs }, { provider: PROVIDER, timeoutMs, signal,
        fetcher: this.environment.fetcher, maxBytes: 4 * MAX_BYTES, requireSolved: false, captureWindow: 'last' });
      signal.throwIfAborted();
      if (page.url !== url) throw new SchemaError(PROVIDER, 'Onex left its tracker');
      const replies = page.capturedResponses.filter(row => row.url === lookup);
      if (replies.length > 2) throw new SchemaError(PROVIDER, 'Onex returned too many tracking replies');
      if (replies.some(row => row.trackingNumberSubmitted !== number)) throw new SchemaError(PROVIDER, 'Onex did not bind the whole tracking request');
      const row = replies.at(-1);
      if (row) {
        if ([401, 403, 428, 503].includes(row.status) || row.error === 'challenge-html') {
          throw new ChallengeError(PROVIDER, 'Onex refused guest verification', { status: row.status });
        }
        const retry = Object.entries(row.headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1];
        const ms = retry === undefined ? NaN : /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
        const retryAfterMs = Number.isFinite(ms) ? Math.max(0, ms) : undefined;
        if (row.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs);
        if (row.status !== 200) throw new UpstreamHttpError(PROVIDER, row.status, retryAfterMs);
        if (row.error === 'invalid-json') throw new SchemaError(PROVIDER, 'Onex returned invalid tracking JSON');
        if (row.error || row.truncated || row.base64Encoded || typeof row.body !== 'string'
          || new TextEncoder().encode(row.body).byteLength > MAX_BYTES) throw new TransportError(PROVIDER, 'Onex returned incomplete tracking data');
        let data: unknown; try { data = JSON.parse(row.body); } catch { throw new SchemaError(PROVIDER, 'Onex returned invalid tracking JSON'); }
        return parseOnex(data);
      }
      // Cloudflare's challenge page that never let the tracker load.
      if ([401, 403, 428, 503].includes(page.statusCode)) throw new ChallengeError(PROVIDER, 'Onex refused its tracker', { status: page.statusCode });
      if (page.statusCode === 429) throw new RateLimitedError(PROVIDER);
      if (page.statusCode >= 400) throw new UpstreamHttpError(PROVIDER, page.statusCode);
      const timing: unknown = Array.isArray(page.raw.timings) ? page.raw.timings.at(-1) : undefined;
      const reason = isRecord(timing) && typeof timing.reason === 'string' ? timing.reason : '';
      if (reason === 'onex-runtime') throw new TransportError(PROVIDER, 'Onex could not open its tracker');
      throw new TransportError(PROVIDER, 'Onex did not capture its tracking reply');
    } catch (error) {
      // The outer browser-service request can contain the input or session state.
      if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
      if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
      throw error;
    }
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new OnexTracker(environment);
  return { id: 'onex', steps: ['trawl'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context) };
};
