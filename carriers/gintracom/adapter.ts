import type { AdapterEnvironment, AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, NotFoundError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError,
  UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS } from '../../core/transport/trawl.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { isRecord } from '../../core/types.js';
import { MAX_BYTES, normalizeGintracomNumber, parseGintracom, PROVIDER } from './parser.js';

export { normalizeGintracomNumber, parseGintracom } from './parser.js';

export const GINTRACOM_ORIGIN = 'https://ec.gintracom.site';
/** The tracker page for one guide, which looks it up as it loads. */
export const gintracomPageUrl = (number: string): string => `${GINTRACOM_ORIGIN}/tracking?${new URLSearchParams({ guia: number })}`;
/** The address the page posts a guide to, with the guide and its reCAPTCHA token in a JSON body. */
export const gintracomLookupUrl = (): string => `${GINTRACOM_ORIGIN}/api/v1/tracking/detalle`;
// The tracker's answer for a guide it does not know.
const UNKNOWN = /^No encontramos esa gu[ií]a\b/i;

export class GintracomTracker {
  constructor(private readonly environment: AdapterEnvironment, private readonly now: () => number = Date.now) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeGintracomNumber(raw);
    return runSteps({ carrier: PROVIDER, recorder: this.environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 60_000 + TRAWL_TRANSPORT_ALLOWANCE_MS }, [
      { id: 'trawl', run: ({ signal, remainingMs }) => this.browser(number, signal, remainingMs) },
    ]);
  }

  // Cloudflare guards the tracker, and every lookup carries an invisible reCAPTCHA token the page
  // gets for itself, so the page asks and the browser service hands back only that guide's reply.
  private async browser(number: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
    const trawl = this.environment.trawl;
    if (!trawl) throw new ChallengeError(PROVIDER, 'Gintracom needs the browser tracking service');
    const url = gintracomPageUrl(number), lookup = gintracomLookupUrl();
    const allowance = Math.min(TRAWL_TRANSPORT_ALLOWANCE_MS, Math.max(1000, Math.floor(remainingMs / 10)));
    const timeoutMs = Math.floor(Math.min(45_000, remainingMs - allowance));
    if (timeoutMs < 8000) throw new BudgetExceededError(PROVIDER, remainingMs);
    try {
      const page = await trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
        captureResponses: [lookup], settleTimeout: timeoutMs }, { provider: PROVIDER, timeoutMs, signal,
        fetcher: this.environment.fetcher, maxBytes: 4 * MAX_BYTES, requireSolved: false, captureWindow: 'last' });
      signal.throwIfAborted();
      if (page.url !== url) throw new SchemaError(PROVIDER, 'Gintracom left its tracker page');
      const replies = page.capturedResponses.filter(row => row.url === lookup);
      if (replies.length > 2) throw new SchemaError(PROVIDER, 'Gintracom returned too many tracking replies');
      if (replies.some(row => row.trackingNumberSubmitted !== number)) throw new SchemaError(PROVIDER, 'Gintracom did not bind the whole tracking request');
      const timing: unknown = Array.isArray(page.raw.timings) ? page.raw.timings.at(-1) : undefined;
      const reason = isRecord(timing) && typeof timing.reason === 'string' ? timing.reason : '';
      const row = replies.at(-1);
      if (row) {
        // A missing token, or one reCAPTCHA refuses, gets a 422 the helper marks.
        if ([401, 403, 428].includes(row.status) || row.error === 'challenge-html' || row.error === 'recaptcha-refused') {
          throw new ChallengeError(PROVIDER, 'Gintracom refused guest verification', { status: row.status });
        }
        const retryAfter = retryAfterMs(Object.entries(row.headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1]);
        if (row.status === 429) throw new RateLimitedError(PROVIDER, retryAfter);
        if (row.status !== 200 && row.status !== 404) throw new UpstreamHttpError(PROVIDER, row.status, retryAfter);
        if (row.error === 'invalid-json') throw new SchemaError(PROVIDER, 'Gintracom returned invalid tracking JSON');
        if (row.error || row.truncated || row.base64Encoded || typeof row.body !== 'string'
          || new TextEncoder().encode(row.body).byteLength > MAX_BYTES) throw new TransportError(PROVIDER, 'Gintracom returned incomplete tracking data');
        let data: unknown; try { data = JSON.parse(row.body); } catch { throw new SchemaError(PROVIDER, 'Gintracom returned invalid tracking JSON'); }
        if (row.status === 404) {
          if (isRecord(data) && typeof data.message === 'string' && UNKNOWN.test(data.message.trim())) {
            throw new NotFoundError(PROVIDER, 'Gintracom does not know this guide');
          }
          throw new TransportError(PROVIDER, 'Gintracom could not find its tracking service');
        }
        return parseGintracom(data, number, this.now());
      }
      if ([401, 403, 428].includes(page.statusCode)) throw new ChallengeError(PROVIDER, 'Gintracom refused its tracker page', { status: page.statusCode });
      // The invisible check showed its pictures, which the browser service does not answer.
      if (reason === 'gintracom-recaptcha-pictures') throw new ChallengeError(PROVIDER, 'Gintracom asked for a picture check');
      if (page.statusCode === 429) throw new RateLimitedError(PROVIDER);
      if (page.statusCode >= 400) throw new UpstreamHttpError(PROVIDER, page.statusCode);
      if (reason === 'gintracom-runtime') throw new TransportError(PROVIDER, 'Gintracom could not open its tracker page');
      throw new TransportError(PROVIDER, 'Gintracom did not capture its tracking reply');
    } catch (error) {
      // The outer browser-service request can contain the input or session state.
      if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
      if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
      throw error;
    }
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new GintracomTracker(environment);
  return { id: PROVIDER, steps: ['trawl'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context) };
};
