
import { DateTime } from 'luxon';
import { load } from 'cheerio';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { clean, cleanScalar, TRAWL_TRANSPORT_ALLOWANCE_MS, TrawlClient } from '../../core/transport/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { royalMailEventStage, royalMailStage, royalMailSummaryStage, statusForStage } from './status.js';

/** Read the response produced by Royal Mail's form and hCaptcha callback. */
const TRACKING_BASE = 'https://www.royalmail.com/track-your-item';
const SUMMARY_API_PREFIX = 'https://api-web.royalmail.com/mailpieces/microsummary/v1/summary/';
const EVENTS_API_PREFIX = 'https://api-web.royalmail.com/mailpieces/v3/';
const MAX_BYTES = 10_000_000;
const DEFAULT_TIMEOUT_MS = 60_000;
// How long the browser may wait for the page's own summary call after the page settles.
const SETTLE_TIMEOUT_MS = 15_000;
// Captured replies beyond this many are noise, never the answer.
const MAX_CAPTURED = 20;
const MAX_EVENTS_TO_INSPECT = 500;
const MAX_EVENTS_TO_RETURN = 100;
export function normalizeRoyalMailNumber(raw: string): string {
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!/^[A-Z]{2}\d{9}GB$/.test(value)) {
    throw new InvalidInputError('Royal Mail', 'Royal Mail tracking numbers must match the UPU S10 format');
  }
  return value;
}

export function royalMailTrackingUrl(trackingNumber: string): string {
  return `${TRACKING_BASE}#/tracking-results/${normalizeRoyalMailNumber(trackingNumber)}`;
}

export function royalMailSummaryApiUrl(trackingNumber: string): string {
  return `${SUMMARY_API_PREFIX}${normalizeRoyalMailNumber(trackingNumber)}`;
}

export function royalMailEventsApiUrl(trackingNumber: string): string {
  return `${EVENTS_API_PREFIX}${normalizeRoyalMailNumber(trackingNumber)}/events`;
}

/** Preserve offset-free wall time instead of assigning a zone to overseas scans. */
function eventTime(value: unknown): string | null {
  const raw = cleanScalar(value, 64);
  // A date or wall clock must never acquire the carrier's default timezone.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-](?:(?:0\d|1[0-3]):?[0-5]\d|14:?00))$/i.test(raw)) return null;
  return explicitOffsetTime(raw)?.iso ?? null;
}

/** A delivery estimate reduced to its calendar day. */
function expectedDelivery(value: unknown): string | null {
  const raw = cleanScalar(value, 64);
  const day = /^\d{4}-\d{2}-\d{2}/.exec(raw)?.[0];
  return day && DateTime.fromISO(day).isValid ? day : null;
}

/** Only the field vocabulary consumed by the public tracking application. */
export function parseRoyalMailTrackingResponse(payload: unknown, trackingNumber: string): CarrierResult {
  const number = normalizeRoyalMailNumber(trackingNumber);
  if (!isRecord(payload)) throw new SchemaError('Royal Mail', 'Royal Mail returned an invalid tracking response');
  const errors = Array.isArray(payload.errors) ? payload.errors.filter(isRecord) : [];
  if (errors.some(error => error.errorCode === 'E0015' || error.code === 'E0015')) {
    throw new ChallengeError('Royal Mail', 'Royal Mail denied the tracking session');
  }
  if (String(payload.httpCode) === '429') throw new RateLimitedError('Royal Mail');
  if (errors.length) throw new IndeterminateError('Royal Mail', 'Royal Mail could not confirm the tracking status');
  const mailpiece = payload.mailPieces;
  // Both summary and events endpoints return one object, not the array used by the
  // recent-items endpoint. Never treat a gateway 404 or schema drift as not-found.
  if (!isRecord(mailpiece) || !isRecord(mailpiece.summary)) {
    throw new SchemaError('Royal Mail', 'Royal Mail returned an invalid tracking response');
  }
  if (cleanScalar(mailpiece.mailPieceId).toUpperCase() !== number) {
    throw new SchemaError('Royal Mail', 'Royal Mail did not return the requested parcel');
  }
  const summary = mailpiece.summary;
  const summaryText = cleanScalar(summary.statusDescription);
  if (mailpiece.events !== undefined && !Array.isArray(mailpiece.events)) {
    throw new SchemaError('Royal Mail', 'Royal Mail returned invalid tracking events');
  }
  const scans = Array.isArray(mailpiece.events) ? mailpiece.events : [];
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const raw of scans.slice(0, MAX_EVENTS_TO_INSPECT)) {
    if (!isRecord(raw)) throw new SchemaError('Royal Mail', 'Royal Mail returned invalid tracking events');
    // The website returns Markdown emphasis, including "**Delivered by**".
    // Normalize it before classification so delivery prose is still redacted.
    const description = cleanScalar(raw.eventName).replace(/\*\*/g, '').trim();
    if (!description) throw new SchemaError('Royal Mail', 'Royal Mail returned invalid tracking events');
    const code = cleanScalar(raw.eventCode, 64);
    const mapped = royalMailEventStage(code);
    const stage = mapped ?? royalMailStage(description) ?? undefined;
    const time = eventTime(raw.eventDateTime);
    const timeText = cleanScalar(raw.eventDateTime, 64);
    const location = cleanScalar(raw.locationName, 250);
    const event: CarrierEvent = {
      ...(time ? { time } : {}),
      ...(!time && timeText ? { provider_time_text: timeText } : {}),
      ...(location ? { location } : {}),
      description: stage === 'delivered' ? 'Delivered' : description,
      ...(stage ? { stage } : {}),
      ...(mapped ? { stage_source: 'carrier_map' } : {}),
      ...(/^[A-Za-z0-9_-]+$/.test(code) ? { provider_code: code } : {}),
    };
    const identity = JSON.stringify([time ?? timeText, location, event.description]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(event);
  }
  // Royal Mail also sorts the history; upstream order is not guaranteed.
  // A partial comparator can move resolved scans across unresolved overseas
  // clocks. Preserve provider order unless every scan denotes an instant.
  if (events.every(event => event.time)) {
    events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));
  }
  const trimmed = events.slice(0, MAX_EVENTS_TO_RETURN);
  const summaryCategory = cleanScalar(summary.statusCategory);
  const statusText = summaryText || summaryCategory || trimmed[0]?.description;
  if (!statusText) throw new SchemaError('Royal Mail', 'Royal Mail returned no usable tracking status');
  const stage = royalMailSummaryStage(summaryCategory, statusText) ?? undefined;
  const delivered = stage === 'delivered';
  return {
    status: stage ? statusForStage(stage) : 'unknown',
    ...(stage ? { current_stage: stage } : {}),
    last_status_text: delivered ? 'Delivered' : statusText,
    last_update: eventTime(summary.lastEventDateTime) || trimmed[0]?.time || null,
    expected_delivery: delivered || !isRecord(mailpiece.estimatedDelivery)
      ? null : expectedDelivery(mailpiece.estimatedDelivery.date),
    events: trimmed,
    ...(trimmed.length ? {} : { summary_only: true }),
  };
}

/**
 * The page the browser rendered, read only to tell a bot challenge from an
 * inconclusive load. Rendered text never decides not-found: only the
 * structured reply does.
 */
export function parseRoyalMailTrackingHtml(page: string): 'challenged' | 'inconclusive' {
  const $ = load(page);
  $('script, style, noscript').remove();
  const visible = clean($('body').text(), 20_000);
  if (/access denied|just a moment|attention required|are you a robot|verify you are human|before you proceed|unusual traffic/i.test(visible)) {
    return 'challenged';
  }
  return 'inconclusive';
}

export interface RoyalMailTrackerOptions {
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
  }

  /** The injected browser service, or one built from the configured URL. */
  #browserService(): TrawlClient | null {
    if (this.#trawl !== undefined) return this.#trawl;
    return this.trawlUrl ? new TrawlClient(this.trawlUrl, this.#fetcher) : null;
  }

  async fetch(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeRoyalMailNumber(trackingNumber);
    // Akamai refuses every non-browser client, so a direct attempt only burns
    // time. There is one step, and it is the browser.
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
          estimatedDelivery: summaryPiece.estimatedDelivery, events: historyPiece.events,
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

export const adapter: AdapterFactory = (environment) => {
  const tracker = new RoyalMailTracker({
    fetcher: environment.fetcher,
    trawl: environment.trawl,
    recorder: environment.recorder,
    fullHistory: true,
  });
  return {
    id: 'royal-mail', recordsSteps: true,
    // Akamai refuses every non-browser client, so there is no direct tier.
    steps: ['trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
