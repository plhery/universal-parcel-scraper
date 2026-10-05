import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { cleanScalar, TRAWL_TRANSPORT_ALLOWANCE_MS, TrawlClient } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { fetchRoyalMailInBrowser } from './browser.js';
import { normalizeRoyalMailNumber, parseRoyalMailTrackingHtml, parseRoyalMailTrackingResponse,
  royalMailEventsApiUrl, royalMailSummaryApiUrl, royalMailTrackingUrl } from './parser.js';

export { normalizeRoyalMailNumber, parseRoyalMailTrackingHtml, parseRoyalMailTrackingResponse,
  royalMailEventsApiUrl, royalMailSummaryApiUrl, royalMailTrackingUrl } from './parser.js';

const MAX_BYTES = 10_000_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const SETTLE_TIMEOUT_MS = 15_000;
const MAX_CAPTURED = 20;

export interface RoyalMailTrackerOptions {
  /** Fresh local Chromium; preferred when supplied. */
  executablePath?: string | null;
  timeoutMs?: number;
  /** Legacy configuration seam; `trawl` is preferred. */
  trawlUrl?: string;
  /** The browser service, or null when none is configured. */
  trawl?: TrawlClient | null;
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
  /** Request the page's separate events flow; summary-only calls remain the default. */
  fullHistory?: boolean;
}

export class RoyalMailTracker {
  readonly timeoutMs: number;
  readonly trawlUrl: string;
  readonly #trawl: TrawlClient | null | undefined;
  readonly #fetcher: typeof fetch | undefined;
  readonly #recorder: StepRecorder;
  readonly #fullHistory: boolean;
  readonly #executablePath: string | null;

  constructor(options: RoyalMailTrackerOptions = {}) {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new TypeError('Royal Mail timeout must be positive');
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.trawlUrl = (options.trawlUrl ?? '').trim();
    this.#trawl = options.trawl;
    this.#fetcher = options.fetcher;
    this.#recorder = options.recorder ?? NOOP_RECORDER;
    this.#fullHistory = options.fullHistory ?? false;
    this.#executablePath = options.executablePath ?? null;
  }

  /** The injected browser service, or one built from the configured URL. */
  #browserService(): TrawlClient | null {
    if (this.#trawl !== undefined) return this.#trawl;
    return this.trawlUrl ? new TrawlClient(this.trawlUrl, this.#fetcher) : null;
  }

  async fetch(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeRoyalMailNumber(trackingNumber);
    if (this.#executablePath) {
      return runSteps<CarrierResult>({ carrier: 'royal-mail', budgetMs: context.budgetMs ?? this.timeoutMs,
        signal: context.signal, recorder: this.#recorder }, [{ id: 'browser', run: ({ remainingMs, signal }) =>
        fetchRoyalMailInBrowser(number, this.#executablePath!, signal, Math.min(60_000, remainingMs), this.#fullHistory) }]);
    }
    // The legacy service remains available through explicit tracker instances.
    const trawl = this.#browserService();
    if (!trawl) {
      throw new ChallengeError(
        'Royal Mail',
        'Royal Mail challenged direct tracking; configure FLARESOLVERR_URL for browser fallback',
      );
    }
    return runSteps<CarrierResult>({
      // Without a caller's budget the lookup leaves the service its own time and
      // the request the allowance to bring the answer back.
      carrier: 'royal-mail', budgetMs: context.budgetMs ?? this.timeoutMs + TRAWL_TRANSPORT_ALLOWANCE_MS, signal: context.signal,
      recorder: this.#recorder,
    }, [
      { id: 'trawl', run: ({ remainingMs, signal }) => this.#trawlResult(trawl, number, Math.max(1, Math.floor(Math.min(this.timeoutMs, remainingMs))), signal) },
    ]);
  }

  /**
   * A real browser loads the page and makes the tracking calls itself; the
   * service hands that reply back. The browser's session is never replayed
   * over plain HTTP: the edge accepts the call only from the session it
   * validated. The page the browser rendered only tells a challenge apart.
   */
  async #trawlResult(trawl: TrawlClient, number: string, timeoutMs: number, signal: AbortSignal): Promise<CarrierResult> {
    const summaryUrl = royalMailSummaryApiUrl(number);
    const eventsUrl = royalMailEventsApiUrl(number);
    const page = await trawl.scrape({
      url: royalMailTrackingUrl(number),
      skipHttp: true,
      maxTier: 3,
      maxTimeout: timeoutMs,
      captureResponses: this.#fullHistory ? [summaryUrl, eventsUrl] : [summaryUrl],
      settleTimeout: SETTLE_TIMEOUT_MS,
    }, {
      provider: 'TRAWL while fetching Royal Mail',
      // A browser may validate its cached main document with 304 while the
      // freshly submitted tracking request still returns a normal JSON reply.
      requireSolved: false,
      timeoutMs,
      maxBytes: MAX_BYTES,
      fetcher: this.#fetcher,
      signal,
    });
    if (![2, 3].includes(page.tier) || ![200, 304].includes(page.statusCode)) {
      throw new TransportError('Royal Mail', 'The browser service did not load the Royal Mail tracking page');
    }
    let captureError: unknown;
    const readCaptured = (targetUrl: string): unknown => {
      // Newest first: a later reply is the page's final answer. The entry URL
      // itself carries the number, so only the exact requested call is read.
      for (const entry of page.capturedResponses.slice(0, MAX_CAPTURED).reverse()) {
        if (entry.url !== targetUrl) continue;
        if (entry.status === 429) {
          const retry = entry.headers['retry-after'];
          const retryMs = retry && /^\d+$/.test(retry) ? Number(retry) * 1_000 : undefined;
          throw new RateLimitedError('Royal Mail', retryMs);
        }
        if ([401, 403].includes(entry.status)) throw new ChallengeError('Royal Mail');
        if (entry.status === 404 && entry.body && !entry.truncated && !entry.base64Encoded && !entry.error) {
          let payload: unknown;
          try { payload = JSON.parse(entry.body); } catch { /* Keep the HTTP failure below. */ }
          if (isRecord(payload) && Array.isArray(payload.errors)
            && payload.errors.some(error => isRecord(error) && error.errorCode === 'E1142')) {
            throw new IndeterminateError('Royal Mail', 'Royal Mail could not confirm the tracking status');
          }
        }
        if ([404, 410].includes(entry.status)) throw new TransportError('Royal Mail', 'Royal Mail tracking endpoint is unavailable');
        if (entry.status >= 400) throw new UpstreamHttpError('Royal Mail', entry.status);
        if (entry.status !== 200 || entry.truncated || entry.base64Encoded || entry.error || entry.body === null) continue;
        try {
          return JSON.parse(entry.body) as unknown;
        } catch (error) {
          // An unreadable or unrelated reply; the rendered page may still name a challenge.
          if (!(error instanceof SyntaxError)) throw error;
          captureError = error;
        }
      }
      return undefined;
    };
    const summaryPayload = readCaptured(summaryUrl);
    if (summaryPayload !== undefined) {
      // Validate the summary independently before merging its status with history.
      const summaryResult = this.#structuredResult(number, summaryPayload);
      if (!this.#fullHistory) return summaryResult;
      const historyPayload = readCaptured(eventsUrl);
      if (historyPayload !== undefined) {
        if (!isRecord(historyPayload)) throw new SchemaError('Royal Mail', 'Royal Mail returned invalid tracking events');
        // Preserve the same error vocabulary as the summary endpoint.
        if (historyPayload.errors !== undefined || historyPayload.httpCode !== undefined) {
          parseRoyalMailTrackingResponse(historyPayload, number);
        }
        const historyPiece = historyPayload.mailPieces;
        if (!isRecord(historyPiece) || cleanScalar(historyPiece.mailPieceId).toUpperCase() !== number
          || !Array.isArray(historyPiece.events)) {
          throw new SchemaError('Royal Mail', 'Royal Mail did not return the requested parcel history');
        }
        const summaryPiece = (summaryPayload as { mailPieces: Record<string, unknown> }).mailPieces;
        return this.#structuredResult(number, { mailPieces: {
          mailPieceId: number, summary: summaryPiece.summary,
          estimatedDelivery: historyPiece.estimatedDelivery ?? summaryPiece.estimatedDelivery, events: historyPiece.events,
        } });
      }
    }
    if (parseRoyalMailTrackingHtml(page.html) === 'challenged') {
      throw new ChallengeError('Royal Mail', 'Royal Mail challenged the browser tracking session', { cause: captureError });
    }
    throw new TransportError('Royal Mail', 'TRAWL did not capture the Royal Mail tracking response', { cause: captureError });
  }

  #structuredResult(number: string, payload: unknown): CarrierResult {
    const result = parseRoyalMailTrackingResponse(payload, number);
    result.tracking_url = royalMailTrackingUrl(number);
    result.tracking_source = 'structured-web-response';
    return result;
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new RoyalMailTracker({ executablePath: environment.browserExecutablePath,
    recorder: environment.recorder, fullHistory: true });
  return {
    id: 'royal-mail', recordsSteps: true, steps: ['browser'],
    track: (input, context) => {
      normalizeRoyalMailNumber(input.number);
      if (!environment.browserExecutablePath) throw new ChallengeError('Royal Mail', 'Royal Mail requires TRACKING_CHROMIUM_PATH');
      return tracker.fetch(input.number, context);
    },
  };
};
