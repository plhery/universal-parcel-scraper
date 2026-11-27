import { recognizeFromBrowserLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import {
  BudgetExceededError, carrierErrorKind, ChallengeError, NoHistoryError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError,
} from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { HoldKind, serviceTag } from '../../core/runner/holds.js';
import { runSteps, type StepSpec } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { browserContextProxy } from '../../core/transport/browserRouteTrial.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient, type TrawlScrapeResponse } from '../../core/transport/trawl.js';
import { DPD_RO_MAX_BYTES, normalizeDpdRoNumber, parseDpdRoReply, PROVIDER } from './parser.js';

/** The least of the browser service's time in which the tracker page passes its Turnstile check and answers. */
const PAGE_MIN_MS = 10_000;

// The endpoint MyDPD's public tracker reads a shipment from; the DPD app ships
// the same path. It answers only a request carrying the token of the page's
// Turnstile check. tracking.dpd.ro sits behind a Cloudflare challenge as well.
export const DPD_RO_ENDPOINT = 'https://mydpd.dpd.ro/rest/public/track';

/**
 * How long lookups leave the tracker page after it met MyDPD's Turnstile check. While the check turns the
 * browser service away, each page spends the service's time on the same refusal, so lookups in the rest end
 * with the endpoint's challenge, recognition included. The first lookup after it opens the page again. Each
 * browser service, and each proxy it opens the page through, has its own rest; a host that keeps adapters'
 * holds (`keepAdapterHolds`) keeps it across restarts.
 */
export const DPD_RO_PAGE_REST_MS = 60 * 60_000;
const pageRests = new Map<string, number>();
const pageHolds = new HoldKind('dpd-ro-page-rest', (key, until) => {
  pageRests.set(key, Math.max(pageRests.get(key) ?? 0, Math.min(until, Date.now() + DPD_RO_PAGE_REST_MS)));
});
const restOf = (trawl: TrawlClient | null, proxy: string | null): string | null =>
  (trawl?.endpoint?.href ? serviceTag(proxy ? `${trawl.endpoint.href} ${proxy}` : trawl.endpoint.href) : null);

/** MyDPD's public tracker for the waybill, in English. */
export const dpdRoTrackingUrl = (raw: string): string =>
  `https://mydpd.dpd.ro/pub/tracking/${normalizeDpdRoNumber(raw)}?language=en`;

/** The request that page sends once its Turnstile check passes. */
export const dpdRoPageRequest = (raw: string): string =>
  `${DPD_RO_ENDPOINT}?id=${normalizeDpdRoNumber(raw)}&language=en&mobile=N`;

/** The tracker page's own reply for the whole waybill, read as the endpoint's. */
export function parseDpdRoPage(page: TrawlScrapeResponse, number: string): CarrierResult {
  if (![2, 3].includes(page.tier) || page.statusCode !== 200) throw new TransportError(PROVIDER, 'The browser service did not load MyDPD\'s tracker');
  const captures = page.capturedResponses.filter((capture) => capture.url === dpdRoPageRequest(number));
  if (!captures.length) throw new ChallengeError(PROVIDER, 'MyDPD\'s tracker sent no tracking request; its Turnstile check did not pass');
  if (captures.length > 10) throw new SchemaError(PROVIDER, 'DPD Romania returned too many tracking responses');
  const capture = captures[captures.length - 1]!;
  if (capture.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(capture.headers['retry-after'], { dates: false }));
  if ([401, 403, 406].includes(capture.status)) throw new ChallengeError(PROVIDER, 'DPD Romania refused its Turnstile check', { status: capture.status });
  if (capture.status !== 200 && capture.status !== 404) throw new UpstreamHttpError(PROVIDER, capture.status);
  if (capture.error || capture.truncated || capture.base64Encoded || capture.body === null) {
    throw new TransportError(PROVIDER, 'DPD Romania returned an incomplete tracking response');
  }
  return parseDpdRoReply(capture.status, capture.body, number);
}

export class DpdRoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null;
    /** The proxy the browser service opens the tracker page through, for a service whose address the check turns away. */
    browserProxy?: string | null; } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeDpdRoNumber(raw);
    const trawl = this.options.trawl ?? null;
    const rest = restOf(trawl, this.options.browserProxy ?? null);
    const resting = rest !== null && (pageRests.get(rest) ?? 0) > Date.now();
    return runSteps({ carrier: 'dpd-ro', budgetMs: context.budgetMs ?? (trawl ? 60_000 : 15_000), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      const { response, bytes } = await fetchBounded(`${DPD_RO_ENDPOINT}?${new URLSearchParams({ id: number, language: 'en' })}`, { signal,
        headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(trawl ? Math.min(10_000, remainingMs) : remainingMs)), maxBytes: DPD_RO_MAX_BYTES,
        allowHttpStatuses: [404, 406], fetcher: this.options.fetcher,
      });
      return parseDpdRoReply(response.status, decodeText(bytes), number);
    } }, { ...this.#page(number, trawl, rest), enabled: Boolean(trawl) && !resting, recovers: (error) => carrierErrorKind(error) === 'challenge' }]);
  }

  #page(number: string, trawl: TrawlClient | null, rest: string | null): StepSpec<CarrierResult> {
    return { id: 'trawl', enabled: Boolean(trawl), run: async ({ signal, remainingMs }) => {
      const timeoutMs = Math.floor(Math.min(45_000, remainingMs - TRAWL_TRANSPORT_ALLOWANCE_MS));
      // The page passes its Turnstile check before it asks for the waybill: with less of the service's time it ends
      // without the reply, so the read is not started and the lookup fails as its budget.
      if (timeoutMs < PAGE_MIN_MS) throw new BudgetExceededError(PROVIDER, remainingMs);
      // The page gets its own Turnstile token and asks for the waybill in its route; the token stays in the browser.
      const page = await trawl!.scrape({ url: dpdRoTrackingUrl(number), skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
        captureResponses: [DPD_RO_ENDPOINT], settleTimeout: Math.min(timeoutMs, 20_000),
        ...(this.options.browserProxy ? { proxy: this.options.browserProxy } : {}),
      }, { provider: 'TRAWL while fetching DPD Romania', timeoutMs, signal, maxBytes: 6_000_000, requireSolved: false });
      signal.throwIfAborted();
      try {
        return parseDpdRoPage(page, number);
      } catch (error) {
        if (rest !== null && carrierErrorKind(error) === 'challenge') {
          const until = Date.now() + DPD_RO_PAGE_REST_MS;
          pageRests.set(rest, until);
          pageHolds.save(rest, until);
        }
        throw error;
      }
    } };
  }
}

export const adapter: AdapterFactory = environment => {
  const browserProxy = environment.env.DPD_RO_BROWSER_PROXY_URL?.trim() || null;
  // Checked here, so a mistyped proxy fails at setup with a message that leaves its value out.
  if (browserProxy) browserContextProxy(browserProxy);
  const tracker = new DpdRoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent,
    trawl: environment.trawl, browserProxy });
  // No HTTP recognition: without the tracker page's Turnstile token a plain request can only be refused. Browser
  // recognition makes the lookup with its page.
  return { id: 'dpd-ro', recordsSteps: true, steps: ['direct', 'trawl'], track: (input, context) => tracker.fetch(input.number, context),
    recognizeWithBrowser: (number, context) => recognizeFromBrowserLookup(async () => {
      const result = await tracker.fetch(number, context);
      // A reply for the whole waybill without a scan is DPD Romania's record of it, with no history to reuse.
      if (!result.events?.length) throw new NoHistoryError(PROVIDER, 'DPD Romania holds the waybill without a scan', { reason: 'listed' });
      return result;
    }) };
};
