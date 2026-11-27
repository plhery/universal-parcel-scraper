import { accepted, recognizeFromBrowserLookup, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import {
  BudgetExceededError, carrierErrorKind, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError,
} from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps, type StepSpec } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { browserContextProxy } from '../../core/transport/browserRouteTrial.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient, type TrawlScrapeResponse } from '../../core/transport/trawl.js';
import { normalizeSpeedyNumber, parseSpeedyReply, PROVIDER, SPEEDY_MAX_BYTES } from './parser.js';

/** The least of the browser service's time in which the tracker page passes its Turnstile check and answers. */
const PAGE_MIN_MS = 10_000;

// The endpoint MySpeedy's public tracker reads a shipment from. It answers only
// a request carrying the token of the page's Turnstile check.
export const SPEEDY_ENDPOINT = 'https://myspeedy.speedy.bg/rest/public/track';

/** MySpeedy's public tracker for the number, in English. */
export const speedyTrackingUrl = (raw: string): string =>
  `https://myspeedy.speedy.bg/pub/tracking/${normalizeSpeedyNumber(raw)}?language=en`;

/** The request that page sends once its Turnstile check passes. */
export const speedyPageRequest = (raw: string): string =>
  `${SPEEDY_ENDPOINT}?id=${normalizeSpeedyNumber(raw)}&language=en&mobile=N`;

/** The tracker page's own reply for the whole number, read as the endpoint's. */
export function parseSpeedyPage(page: TrawlScrapeResponse, number: string): CarrierResult {
  if (![2, 3].includes(page.tier) || page.statusCode !== 200) throw new TransportError(PROVIDER, 'The browser service did not load Speedy\'s tracker');
  const captures = page.capturedResponses.filter((capture) => capture.url === speedyPageRequest(number));
  if (!captures.length) throw new ChallengeError(PROVIDER, 'Speedy\'s tracker sent no tracking request; its Turnstile check did not pass');
  if (captures.length > 10) throw new SchemaError(PROVIDER, 'Speedy returned too many tracking responses');
  const capture = captures[captures.length - 1]!;
  if (capture.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(capture.headers['retry-after'], { dates: false }));
  if ([401, 403, 406].includes(capture.status)) throw new ChallengeError(PROVIDER, 'Speedy refused its Turnstile check', { status: capture.status });
  if (capture.status !== 200 && capture.status !== 404) throw new UpstreamHttpError(PROVIDER, capture.status);
  if (capture.error || capture.truncated || capture.base64Encoded || capture.body === null) {
    throw new TransportError(PROVIDER, 'Speedy returned an incomplete tracking response');
  }
  return parseSpeedyReply(capture.status, capture.body, number);
}

export class SpeedyTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null;
    /** The proxy the browser service opens the tracker page through, for a service whose address the check turns away. */
    browserProxy?: string | null; } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeSpeedyNumber(raw);
    const trawl = this.options.trawl ?? null;
    return runSteps({ carrier: 'speedy', budgetMs: context.budgetMs ?? (trawl ? 60_000 : 15_000), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      const { response, bytes } = await fetchBounded(`${SPEEDY_ENDPOINT}?${new URLSearchParams({ id: number, language: 'en' })}`, { signal,
        headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(trawl ? Math.min(10_000, remainingMs) : remainingMs)), maxBytes: SPEEDY_MAX_BYTES,
        allowHttpStatuses: [404, 406], fetcher: this.options.fetcher,
      });
      return parseSpeedyReply(response.status, decodeText(bytes), number);
    } }, { ...this.#page(number, trawl), recovers: (error) => carrierErrorKind(error) === 'challenge' }]);
  }

  /** The tracker page alone, for a number whose direct read has already met the Turnstile check. */
  async browse(raw: string, context: TrackingContext = {}) {
    const number = normalizeSpeedyNumber(raw);
    const trawl = this.options.trawl ?? null;
    if (!trawl) throw new ChallengeError(PROVIDER, 'Speedy\'s tracker needs the browser service');
    return runSteps({ carrier: 'speedy', budgetMs: context.budgetMs ?? 60_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [this.#page(number, trawl)]);
  }

  #page(number: string, trawl: TrawlClient | null): StepSpec<CarrierResult> {
    return { id: 'trawl', enabled: Boolean(trawl), run: async ({ signal, remainingMs }) => {
      const timeoutMs = Math.floor(Math.min(45_000, remainingMs - TRAWL_TRANSPORT_ALLOWANCE_MS));
      // The page passes its Turnstile check before it asks for the number: with less of the service's time it ends
      // without the reply, so the read is not started and the lookup fails as its budget.
      if (timeoutMs < PAGE_MIN_MS) throw new BudgetExceededError(PROVIDER, remainingMs);
      // The page gets its own Turnstile token and asks for the number in its route; the token stays in the browser.
      const page = await trawl!.scrape({ url: speedyTrackingUrl(number), skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
        captureResponses: [SPEEDY_ENDPOINT], settleTimeout: Math.min(timeoutMs, 20_000),
        ...(this.options.browserProxy ? { proxy: this.options.browserProxy } : {}),
      }, { provider: 'TRAWL while fetching Speedy', timeoutMs, signal, maxBytes: 6_000_000, requireSolved: false });
      signal.throwIfAborted();
      return parseSpeedyPage(page, number);
    } };
  }
}

export const adapter: AdapterFactory = environment => {
  const browserProxy = environment.env.SPEEDY_BROWSER_PROXY_URL?.trim() || null;
  // Checked here, so a mistyped proxy fails at setup with a message that leaves its value out.
  if (browserProxy) browserContextProxy(browserProxy);
  const options = { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent };
  const tracker = new SpeedyTracker({ ...options, trawl: environment.trawl, browserProxy });
  // Recognition stays on HTTP.
  const http = new SpeedyTracker(options);
  return { id: 'speedy', recordsSteps: true, steps: ['direct', 'trawl'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => http.fetch(number, context),
      () => accepted(() => normalizeSpeedyNumber(number))),
    // After the HTTP read: a throttle, a malformed reply or a refused number stands; the page is not asked.
    recognizeWithBrowser: (number, context, previous) => {
      if (['rate_limited', 'schema', 'invalid_input'].includes(carrierErrorKind(previous) ?? '')) return Promise.reject(previous);
      if (!accepted(() => normalizeSpeedyNumber(number))) return Promise.resolve({ known: false, lastActivityAt: null });
      return recognizeFromBrowserLookup(() => tracker.browse(number, context));
    } };
};
