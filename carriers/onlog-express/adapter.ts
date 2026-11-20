import { recognizeFromBrowserLookup, type AdapterEnvironment, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { isOnlogExpressReference } from '../../core/detection/onlogExpress.js';
import { BudgetExceededError, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlScrapeResponse } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { normalizeOnlogExpressNumber, ONLOG_EXPRESS_MAX_BYTES, parseOnlogExpress, PROVIDER } from './parser.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';

export const ONLOG_EXPRESS_API = 'https://conecta.log.br/view/jsRastreio.php';
const SERVICE_MS = 60_000;
export function onlogExpressUrl(raw: string): string {
  return 'https://onlog.app.br/rastreio/' + encodeURIComponent(normalizeOnlogExpressNumber(raw));
}
function reason(page: TrawlScrapeResponse): string {
  const timing: unknown = Array.isArray(page.raw.timings) ? page.raw.timings.at(-1) : undefined;
  return isRecord(timing) && typeof timing.reason === 'string' ? timing.reason : '';
}
function retryAfter(headers: Record<string, string>): number | undefined {
  return retryAfterMs(Object.entries(headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1]);
}

export class OnlogExpressTracker {
  constructor(private readonly environment: AdapterEnvironment) {}
  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeOnlogExpressNumber(raw), url = onlogExpressUrl(number);
    return runSteps({ carrier: 'onlog-express', recorder: this.environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? SERVICE_MS + TRAWL_TRANSPORT_ALLOWANCE_MS }, [{ id: 'trawl', run: async ({ signal, remainingMs }) => {
      const trawl = this.environment.trawl;
      if (!trawl) throw new ChallengeError(PROVIDER, 'Onlog Express needs the browser tracking service');
      const allowance = Math.min(TRAWL_TRANSPORT_ALLOWANCE_MS, Math.max(1000, Math.floor(remainingMs / 10)));
      const timeoutMs = Math.floor(Math.min(SERVICE_MS, remainingMs - allowance));
      if (timeoutMs < 8000) throw new BudgetExceededError(PROVIDER, remainingMs);
      try {
        const page = await trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
          captureResponses: [ONLOG_EXPRESS_API], settleTimeout: timeoutMs }, { provider: PROVIDER,
          timeoutMs, signal, fetcher: this.environment.fetcher, maxBytes: 4 * ONLOG_EXPRESS_MAX_BYTES,
          requireSolved: false, captureWindow: 'last' });
        signal.throwIfAborted();
        if (page.url !== url) throw new SchemaError(PROVIDER, 'Onlog Express left its tracking page');
        const replies = page.capturedResponses.filter(row => row.url === ONLOG_EXPRESS_API);
        if (replies.length > 2) throw new SchemaError(PROVIDER, 'Onlog Express returned too many tracking replies');
        let found: CarrierResult | undefined, failure: Error | undefined;
        for (const row of replies) {
          found = undefined;
          if (row.trackingNumberSubmitted !== number) throw new SchemaError(PROVIDER, 'Onlog Express did not bind the whole tracking request');
          if ([400, 401, 403, 428].includes(row.status) || row.error === 'challenge-html') {
            failure = new ChallengeError(PROVIDER, 'Onlog Express refused its guest tracking verification', { status: row.status }); continue;
          }
          if (row.status === 429) { failure = new RateLimitedError(PROVIDER, retryAfter(row.headers)); continue; }
          if (row.status === 0 || [404, 410].includes(row.status)) { failure = new TransportError(PROVIDER, 'Onlog Express tracking is unavailable', { status: row.status }); continue; }
          if (row.status !== 200) { failure = new UpstreamHttpError(PROVIDER, row.status, retryAfter(row.headers)); continue; }
          if (row.error === 'invalid-json') throw new SchemaError(PROVIDER, 'Onlog Express returned invalid tracking JSON');
          if (row.error || row.truncated || row.base64Encoded || typeof row.body !== 'string'
            || new TextEncoder().encode(row.body).byteLength > ONLOG_EXPRESS_MAX_BYTES) {
            failure = new TransportError(PROVIDER, 'Onlog Express returned incomplete tracking data'); continue;
          }
          let data: unknown; try { data = JSON.parse(row.body); } catch { throw new SchemaError(PROVIDER, 'Onlog Express returned invalid tracking JSON'); }
          try { found = parseOnlogExpress(data, number); failure = undefined; }
          catch (error) { if (error instanceof SchemaError) throw error; if (!(error instanceof Error)) throw new SchemaError(PROVIDER); failure = error; }
        }
        if (found) return found;
        if (failure) throw failure;
        if ([401, 403, 428].includes(page.statusCode)) throw new ChallengeError(PROVIDER, 'Onlog Express refused its guest page', { status: page.statusCode });
        if (page.statusCode === 429) throw new RateLimitedError(PROVIDER);
        if ([404, 410].includes(page.statusCode)) throw new TransportError(PROVIDER, 'Onlog Express guest page is unavailable', { status: page.statusCode });
        if (page.statusCode >= 400) throw new UpstreamHttpError(PROVIDER, page.statusCode);
        if (reason(page) === 'onlog-capture_missing') {
          throw new TransportError(PROVIDER, 'Onlog Express could not capture its guest reply', { reason: 'capture_missing' });
        }
        if (reason(page) === 'onlog-runtime') throw new TransportError(PROVIDER, 'Onlog Express could not capture its guest reply');
        throw new ChallengeError(PROVIDER, 'Onlog Express did not finish browser verification', { reason: 'verification_unfinished' });
      } catch (error) {
        // The outer service request URL and diagnostics can carry the input or browser state.
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
        if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
        throw error;
      }
    } }]);
  }
}
export const adapter: AdapterFactory = environment => {
  const tracker = new OnlogExpressTracker(environment);
  return { id: 'onlog-express', steps: ['trawl'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context),
    recognizeWithBrowser: (number, context) => isOnlogExpressReference(number)
      ? recognizeFromBrowserLookup(() => tracker.fetch(number, context)) : Promise.resolve({ known: false, lastActivityAt: null }) };
};
