
import { load } from 'cheerio';
import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import { isValidUpsTrackingNumber } from '../../core/detection/ups.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import { runSteps, singleFlight, takeTurn } from '../../core/runner/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean, cleanScalar, decodeText, fetchBounded, parseJsonBytes, TRAWL_TRANSPORT_ALLOWANCE_MS, TrawlClient } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { UPS_PROGRESS_STATUS, upsActivityStage, upsBannerStage, upsStatus } from './status.js';
import { decodeEntities } from './text.js';

const TRACKING_BASE = 'https://www.ups.com/track';
const STATUS_API = 'https://webapis.ups.com/track/api/Track/GetStatus?loc=en_US';
const TRAWL_PROVIDER = 'TRAWL while fetching UPS';
const MAX_BYTES = 10_000_000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0';
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_DIRECT_TIMEOUT_MS = 20_000;
// How long the browser may wait for the page's own status call after the page settles.
const SETTLE_TIMEOUT_MS = 15_000;
// Captured replies beyond this many are noise, never the answer.
const MAX_CAPTURED = 20;
// Provider strings are short; the rendered page's whole text is not, and the
// identity check reads all of it, so it passes its own limit to `clean`.
const PAGE_TEXT_LIMIT = 2_000_000;

export function upsTrackingUrl(trackingNumber: string): string {
  const url = new URL(TRACKING_BASE);
  url.searchParams.set('loc', 'en_US');
  url.searchParams.set('tracknum', trackingNumber);
  url.searchParams.set('requester', 'ST/trackdetails');
  return url.toString();
}

/**
 * Akamai rejected the session (HTTP 401/403/419/429, or a page that carries no
 * XSRF token). It stays a distinct class because the adapter reacts to it: the
 * cached session is refreshed once, then dropped, before the browser tier runs.
 */
export class UPSSessionRejected extends ChallengeError {
  constructor(message: string) {
    super('UPS', message);
    this.name = 'UPSSessionRejected';
  }
}

/**
 * What one lookup lends each request. A session outlives the lookup that
 * built it, so it is handed these per request and keeps neither.
 */
interface RequestBounds {
  /** Aborts on the caller's signal or when the lookup budget is spent. */
  signal: AbortSignal;
  /** When the lookup budget is spent, on the `performance.now()` clock. */
  deadline: number;
}

class UPSHttpSession {
  readonly jar = new CookieJar();
  readonly #fetcher: typeof fetch;
  #userAgent = USER_AGENT;

  constructor(readonly timeoutMs: number, fetcher?: typeof fetch) {
    // Resolve the global lazily so a test seam installed after construction
    // still sees the request.
    this.#fetcher = makeFetchCookie(fetcher ?? ((input, init) => fetch(input, init)), this.jar);
  }

  async fetchPage(url: string, bounds: RequestBounds): Promise<string> {
    const result = await this.request(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        DNT: '1',
        Pragma: 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-GPC': '1',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': this.#userAgent,
      },
    }, 'UPS tracking page', bounds);
    return decodeText(result);
  }

  async fetchStatus(trackingNumber: string, bounds: RequestBounds): Promise<JsonObject> {
    const token = await this.xsrfToken();
    if (!token) throw new UPSSessionRejected('The UPS session has no XSRF token');
    const clientUrl = upsTrackingUrl(trackingNumber);
    const bytes = await this.request(STATUS_API, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        DNT: '1',
        Origin: 'https://www.ups.com',
        Referer: clientUrl,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
        'Sec-GPC': '1',
        'User-Agent': this.#userAgent,
        'X-XSRF-TOKEN': token,
      },
      body: JSON.stringify({
        Locale: 'en_US',
        TrackingNumber: [trackingNumber.toLocaleLowerCase('en-US')],
        isBarcodeScanned: false,
        Requester: 'st/trackdetails',
        ClientUrl: clientUrl,
        returnToValue: '',
        AssociatedBcdnNumber: null,
      }),
    }, 'UPS status API', bounds);
    const payload = parseJsonBytes(bytes, 'UPS');
    if (!isRecord(payload)) throw new UPSSessionRejected('UPS returned an invalid tracking response');
    return payload;
  }

  async xsrfToken(): Promise<string> {
    const cookies = await this.jar.getCookies(STATUS_API);
    const value = cookies.find((cookie) => cookie.key === 'X-XSRF-TOKEN-ST')?.value ?? '';
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  private async request(
    url: string,
    init: RequestInit,
    description: string,
    bounds: RequestBounds,
  ): Promise<Uint8Array> {
    const result = await fetchBounded(url, { ...init, signal: bounds.signal }, {
      provider: description,
      timeoutMs: Math.max(1, Math.floor(Math.min(this.timeoutMs, bounds.deadline - performance.now()))),
      maxBytes: MAX_BYTES,
      redirect: 'follow',
      fetcher: this.#fetcher,
      allowHttpError: true,
    });
    if ([401, 403, 419, 429].includes(result.response.status)) {
      throw new UPSSessionRejected(`${description} returned HTTP ${result.response.status}`);
    }
    // Any other rejected status proves nothing about the shipment, so the
    // browser tier is still allowed to answer it.
    if (!result.response.ok) {
      throw new IndeterminateError('UPS', `${description} returned HTTP ${result.response.status}`);
    }
    return result.bytes;
  }
}

function withoutIcons(value: string): string {
  return clean(value.replace(/\b(?:check_circle|content_copy|expand_more|check)\b/g, ' '));
}

function notLocated(): CarrierResult {
  return {
    status: 'unknown',
    last_status_text: 'UPS could not locate the shipment',
    last_update: null,
    expected_delivery: null,
    events: [],
  };
}

/**
 * The rendered tracking page, used when no structured answer can be had. It
 * carries the current status and the delivery location block, never a history.
 */
export function parseUPSTrackingHtml(page: string, trackingNumber: string): CarrierResult {
  const $ = load(page);
  $('script, style, noscript').remove();
  const expected = trackingNumber.toUpperCase();
  const visible = clean($('body').text(), PAGE_TEXT_LIMIT).toUpperCase();
  const metaNumbers = $('meta[name]').map((_, element) => {
    const name = clean($(element).attr('name')).toLocaleLowerCase('en-US');
    return ['stapp-tracknum', 'appvars.trk_tracknum'].includes(name)
      ? clean($(element).attr('content')).toUpperCase()
      : '';
  }).get();
  if (!visible.includes(expected) && !metaNumbers.includes(expected)) {
    throw new SchemaError('UPS', 'UPS did not return the requested parcel');
  }
  if (/could not locate|invalid tracking|not valid tracking/i.test(visible)) return notLocated();
  let statusText = withoutIcons(clean($('#stApp_nameKey').last().text()));
  // Only the active milestone: the bar also lists every milestone still ahead,
  // and "Out for Delivery" among those is not the status.
  $('#stApp_shpmtProgress .sr-only').remove();
  const progress = withoutIcons(clean($('#stApp_shpmtProgress .progress-step.active').text()));
  const currentStatus = upsStatus(`${statusText} ${progress}`);
  if (!statusText) statusText = progress || 'Tracking information received';
  // Where a delivered parcel was left. The ship-to block names the recipient's
  // town, not where the parcel is, so it never becomes the banner's place.
  const location = clean($('#stApp_deliveredToAddress').last().text());
  // The banner has no clock, so its event carries none.
  const bannerStage = upsBannerStage(statusText);
  const events: CarrierEvent[] = currentStatus === 'unknown'
    ? []
    : [{ ...(location ? { location } : {}), description: statusText, ...(bannerStage ? { stage: bannerStage } : {}) }];
  return {
    status: currentStatus,
    last_status_text: statusText,
    last_update: null,
    expected_delivery: null,
    events,
  };
}

/** A provider string with its HTML entities decoded, then cleaned. */
function text(value: unknown, maxLength?: number): string {
  return clean(typeof value === 'string' ? decodeEntities(value) : value, maxLength);
}

type ScanClock = Pick<CarrierEvent, 'time'> & { local_time?: string; provider_time_text?: string };

/**
 * A scan's clock. UPS sends the same scan twice: a UTC pair (`gmtDate` /
 * `gmtTime`) and a local pair with a `gmtOffset`. Either becomes an
 * offset-carrying ISO string, so no zone is ever guessed. A local pair without
 * an offset stays a `local_time`, other text stays as UPS wrote it, and a scan
 * with no clock at all, like some label scans, gets none.
 */
function activityClock(activity: JsonObject): ScanClock {
  const gmtDate = cleanScalar(activity.gmtDate);
  const gmtTime = cleanScalar(activity.gmtTime);
  if (/^\d{8}$/.test(gmtDate) && /^\d{2}:\d{2}:\d{2}$/.test(gmtTime)) {
    return { time: `${gmtDate.slice(0, 4)}-${gmtDate.slice(4, 6)}-${gmtDate.slice(6, 8)}T${gmtTime}+00:00` };
  }
  const localDate = cleanScalar(activity.date);
  const localTime = cleanScalar(activity.time);
  const dateMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(localDate);
  const timeMatch = /^(\d{1,2}):([0-5]\d)\s*([AP])\.?M\.?$/i.exec(localTime);
  const hour = Number(timeMatch?.[1]);
  if (dateMatch && timeMatch && hour >= 1 && hour <= 12) {
    const hours = String(hour % 12 + (timeMatch[3]!.toUpperCase() === 'P' ? 12 : 0)).padStart(2, '0');
    const local = `${dateMatch[3]}-${dateMatch[1]}-${dateMatch[2]}T${hours}:${timeMatch[2]}:00`;
    const offset = cleanScalar(activity.gmtOffset);
    return /^[+-]\d{2}:\d{2}$/.test(offset) ? { time: `${local}${offset}` } : { local_time: local };
  }
  const raw = clean(`${localDate} ${localTime}`);
  return raw ? { provider_time_text: raw } : {};
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DAY_MS = 86_400_000;

/**
 * The scheduled delivery date. UPS sends a month key and a day number but no
 * year, so the year is the one that puts the date within the last week or in
 * the future.
 */
function expectedDelivery(detail: JsonObject, today: Date): string | null {
  if (!isRecord(detail.scheduledDeliveryDateDetail)) return null;
  const value = detail.scheduledDeliveryDateDetail;
  const month = MONTHS[cleanScalar(value.monthCMSKey).split('.').at(-1)?.toLocaleLowerCase('en-US') ?? ''];
  const day = Number(cleanScalar(value.dayNum));
  if (!month || !Number.isInteger(day) || day < 1 || day > 31) return null;
  const year = today.getUTCFullYear();
  const candidate = calendarDay(year, month, day);
  if (!candidate) return null;
  const utcToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Date.parse(candidate) < utcToday - 7 * DAY_MS ? calendarDay(year + 1, month, day) : candidate;
}

/** The structured answer of the tracking page's own status API. */
export function parseUPSTrackingResponse(
  payload: unknown,
  trackingNumber: string,
  today = new Date(),
): CarrierResult {
  if (!isRecord(payload)) throw new SchemaError('UPS');
  if (payload.statusCode !== '200' && payload.statusCode !== 200) {
    // UPS answers 402 "Invalid Request" for a number whose check digit fails.
    if (cleanScalar(payload.statusCode) === '402' && !isValidUpsTrackingNumber(trackingNumber.toUpperCase())) {
      throw new InvalidInputError('UPS', 'UPS rejected the number: its check digit does not match');
    }
    throw new IndeterminateError('UPS', clean(payload.statusText) || 'UPS tracking is unavailable');
  }
  if (!Array.isArray(payload.trackDetails) || payload.trackDetails.length === 0) return notLocated();
  const expected = trackingNumber.toUpperCase();
  const detail: unknown = payload.trackDetails.find((item) => isRecord(item)
    && cleanScalar(item.trackingNumber ?? item.requestedTrackingNumber).toUpperCase() === expected)
    ?? payload.trackDetails[0];
  if (!isRecord(detail)) throw new SchemaError('UPS');
  const returned = cleanScalar(detail.trackingNumber ?? detail.requestedTrackingNumber);
  if (returned && returned.toUpperCase() !== expected) {
    throw new SchemaError('UPS', 'UPS did not return the requested parcel');
  }
  const errorText = text(detail.errorText);
  // Error 504 in a successful reply that names the number: UPS has no record of
  // it, expired or not active yet, as its own page reads the code. An outage
  // answers with another status code instead.
  if (returned && cleanScalar(detail.errorCode) === '504') throw new NotFoundError('UPS');
  if (detail.errorCode || errorText) {
    return { ...notLocated(), last_status_text: errorText || 'UPS could not locate the shipment' };
  }
  const events: CarrierEvent[] = [];
  if (Array.isArray(detail.shipmentProgressActivities)) {
    for (const raw of detail.shipmentProgressActivities) {
      if (!isRecord(raw)) continue;
      const milestone = isRecord(raw.milestoneName) ? text(raw.milestoneName.name) : '';
      let description = text(raw.activityScan) || milestone;
      const additional = text(raw.activityAdditionalDescription);
      if (additional && !description.toLocaleLowerCase('en-US').includes(additional.toLocaleLowerCase('en-US'))) {
        description = clean(`${description} — ${additional}`);
      }
      if (!description) continue;
      const code = cleanScalar(raw.actCode, 8).toUpperCase();
      const stage = upsActivityStage(code);
      events.push({
        ...activityClock(raw),
        location: text(raw.location),
        description,
        ...(/^[A-Z0-9]{1,4}$/.test(code) ? { provider_code: code } : {}),
        ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
      });
    }
  }
  const newest = events[0];
  // UPS lists the newest scan first. Its code outranks the coarse progress
  // token, which reads Exception for a mere delay.
  const stage = newest?.stage as Stage | undefined;
  const currentName = isRecord(detail.currentMilestone) ? text(detail.currentMilestone.name) : '';
  const statusText = newest?.description
    || text(detail.packageStatus ?? detail.simplifiedText)
    || currentName
    || 'Tracking information received';
  const progress = clean(detail.progressBarType).toLocaleLowerCase('en-US');
  const status: CarrierStatus = stage ? languageStageStatus(stage) : (Object.hasOwn(UPS_PROGRESS_STATUS, progress)
    ? UPS_PROGRESS_STATUS[progress]!
    : upsStatus(
      [detail.packageStatus, detail.simplifiedText, currentName, statusText].map((value) => text(value)).join(' '),
      events.length > 0,
    ));
  const delivered = stage ? stage === 'delivered' : status === 'delivered';
  const deliveredAt = delivered ? newest?.time : undefined;
  const country = [detail.shipToAddress, detail.deliveryAddress]
    .map((address) => (isRecord(address) ? cleanScalar(address.country, 8).toUpperCase() : ''))
    .find((code) => /^[A-Z]{2}$/.test(code));
  const pickupPoint = stage === 'ready_for_pickup' ? accessPoint(detail) : '';
  // UPS writes its service names with trademark signs ("UPS Standard&#174;"), which are not part of the name.
  const information = isRecord(detail.additionalInformation) ? detail.additionalInformation.serviceInformation : null;
  const service = isRecord(information) ? clean(text(information.serviceName, 200).replace(/[®™℠]/g, ' '), 80) : '';
  // Never projected: the ship-to and delivery addresses beyond their country,
  // `receivedBy`, `leftAt`, the proof-of-delivery link, the access point's
  // attention name, hours and coordinates, and `senderShipperNumber`, an
  // account number.
  return {
    status,
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: statusText,
    last_update: newest?.time ?? null,
    expected_delivery: delivered ? null : expectedDelivery(detail, today),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(pickupPoint ? { pickup_point: pickupPoint } : {}),
    ...(country ? { destination_country: country } : {}),
    ...(service ? { service_name: service } : {}),
    events,
  };
}

/**
 * The access point, read only while the parcel waits there: its business name,
 * then its street and its town on their own lines when UPS gives both. The
 * attention name is never a fallback: it can name a person.
 */
function accessPoint(detail: JsonObject): string {
  const point = isRecord(detail.upsAccessPoint) ? detail.upsAccessPoint : null;
  const location = point && isRecord(point.location) ? point.location : null;
  const name = location ? text(location.companyName, 200) : '';
  if (!location || !name) return name;
  const street = text(location.streetAddress1, 120);
  const more = [location.streetAddress2, location.streetAddress3].map((line) => text(line, 120)).filter(Boolean).join(', ');
  const city = text(location.city, 80);
  if (!street || !city) return name;
  const postcode = text(location.zipCode, 16);
  // A US state or Canadian province comes before the postcode, after the town.
  const region = text(location.state, 40) || text(location.province, 40);
  const town = region ? `${city}, ${[region, postcode].filter(Boolean).join(' ')}` : [postcode, city].filter(Boolean).join(' ');
  return [name, street, more, town].filter(Boolean).join('\n');
}

export interface UPSTrackerOptions {
  timeoutMs?: number;
  directTimeoutMs?: number;
  /** Legacy configuration seam; `trawl` is preferred. */
  trawlUrl?: string;
  /** The browser service, or null when none is configured. */
  trawl?: TrawlClient | null;
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
}

export class UPSTracker {
  readonly timeoutMs: number;
  readonly directTimeoutMs: number;
  readonly trawlUrl: string;
  readonly #trawl: TrawlClient | null | undefined;
  readonly #fetcher: typeof fetch | undefined;
  readonly #recorder: StepRecorder;
  readonly #serialize = singleFlight();
  #session: UPSHttpSession | null = null;

  constructor(options: UPSTrackerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.directTimeoutMs = Math.max(1_000, Math.min(
      this.timeoutMs,
      options.directTimeoutMs ?? DEFAULT_DIRECT_TIMEOUT_MS,
    ));
    this.trawlUrl = (options.trawlUrl ?? '').trim();
    this.#trawl = options.trawl;
    this.#fetcher = options.fetcher;
    this.#recorder = options.recorder ?? NOOP_RECORDER;
  }

  /** The injected browser service, or one built from the configured URL. */
  #browserService(): TrawlClient | null {
    if (this.#trawl !== undefined) return this.#trawl;
    return this.trawlUrl ? new TrawlClient(this.trawlUrl, this.#fetcher) : null;
  }

  async fetch(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    // One lookup at a time: the cached session's cookies and XSRF token are
    // shared state and must never be refreshed by two lookups at once.
    return takeTurn(this.#serialize, 'UPS', context, async (left) => {
      const number = trackingNumber.toUpperCase();
      if (!/^1Z[A-Z0-9]{16}$/.test(number)) {
        throw new InvalidInputError('UPS', 'UPS tracking numbers must start with 1Z and contain 18 characters');
      }
      return this.#lookup(number, left);
    });
  }

  async #lookup(number: string, context: TrackingContext): Promise<CarrierResult> {
    const trawl = this.#browserService();
    // The direct page, kept so it can still be read when no browser service
    // exists and the structured call was refused.
    const page: { html: string | null } = { html: null };
    return runSteps<CarrierResult>({
      // Without a caller's budget the browser tier leaves the service its own time
      // and the request the allowance to bring the answer back.
      carrier: 'ups', budgetMs: context.budgetMs ?? this.timeoutMs + (trawl ? TRAWL_TRANSPORT_ALLOWANCE_MS : 0), signal: context.signal,
      recorder: this.#recorder,
    }, [
      {
        id: 'direct',
        // Plain HTTP serves only deployments without a browser service. Since
        // 2026-09-10 Akamai holds the status API open until the timeout for
        // every session a browser did not establish, so with a browser the
        // structured answer is read from the page's own call instead.
        enabled: trawl === null,
        run: async ({ remainingMs, signal }) => {
          try {
            return await this.#directResult(number, page, { signal, deadline: performance.now() + remainingMs });
          } catch (error) {
            // A caller that cancelled gets its own reason back: no answer from
            // the page already fetched, no challenge report.
            context.signal?.throwIfAborted();
            // UPS refused or does not know the number; no page or browser can answer it.
            if (error instanceof InvalidInputError || error instanceof NotFoundError) throw error;
            if (page.html !== null) {
              try {
                return this.#renderedResult(page.html, number);
              } catch {
                // The direct page was itself a challenge; surface the actionable setup error.
              }
            }
            throw new ChallengeError(
              'UPS',
              'UPS challenged direct tracking; configure FLARESOLVERR_URL for browser fallback',
              { cause: error },
            );
          }
        },
      },
      {
        id: 'trawl',
        enabled: trawl !== null,
        run: ({ remainingMs, signal }) => this.#trawlResult(
          trawl!, number, Math.max(1, Math.floor(Math.min(this.timeoutMs, remainingMs))), signal,
        ),
      },
    ]);
  }

  /** The cached session, then a fresh one; both talk plain HTTP to the status API. */
  async #directResult(number: string, page: { html: string | null }, bounds: RequestBounds): Promise<CarrierResult> {
    const cached = this.#session;
    if (cached) {
      try {
        return await this.#apiResult(number, cached, bounds);
      } catch (error) {
        if (!(error instanceof UPSSessionRejected)) throw error;
        try {
          await cached.fetchPage(upsTrackingUrl(number), bounds);
          return await this.#apiResult(number, cached, bounds);
        } catch (refreshError) {
          if (!(refreshError instanceof UPSSessionRejected)) throw refreshError;
          this.#session = null;
        }
      }
    }
    const direct = new UPSHttpSession(this.directTimeoutMs, this.#fetcher);
    page.html = await direct.fetchPage(upsTrackingUrl(number), bounds);
    if (!await direct.xsrfToken()) throw new UPSSessionRejected('UPS challenged the direct tracking session');
    const result = await this.#apiResult(number, direct, bounds);
    this.#session = direct;
    return result;
  }

  /**
   * A real browser loads the page and makes the status call itself; the
   * service hands that reply back. The browser's cookies are never replayed
   * over plain HTTP: Akamai accepts the call only from the session it
   * validated in the page. The page the browser rendered is the last resort.
   */
  async #trawlResult(trawl: TrawlClient, number: string, timeoutMs: number, signal: AbortSignal): Promise<CarrierResult> {
    const page = await trawl.scrape({
      url: upsTrackingUrl(number),
      skipHttp: true,
      maxTier: 3,
      maxTimeout: timeoutMs,
      captureResponses: [STATUS_API],
      settleTimeout: SETTLE_TIMEOUT_MS,
    }, {
      provider: TRAWL_PROVIDER,
      timeoutMs,
      maxBytes: MAX_BYTES,
      fetcher: this.#fetcher,
      signal,
    });
    let captureError: Error | undefined;
    // Newest first: a later reply is the page's final answer.
    for (const entry of page.capturedResponses.slice(0, MAX_CAPTURED).reverse()) {
      if (entry.url !== STATUS_API || entry.status !== 200 || entry.truncated || entry.body === null) continue;
      try {
        return this.#structuredResult(number, JSON.parse(entry.body));
      } catch (error) {
        if (error instanceof InvalidInputError || error instanceof NotFoundError) throw error;
        // An unreadable or unrelated reply; the rendered page may still answer.
        captureError = error instanceof Error ? error : new SchemaError('UPS', 'UPS returned invalid tracking data', { cause: error });
      }
    }
    try {
      return this.#renderedResult(page.html, number);
    } catch (error) {
      if (captureError) throw captureError;
      throw new TransportError('UPS', 'TRAWL did not capture the UPS status response', { cause: error });
    }
  }

  async #apiResult(number: string, session: UPSHttpSession, bounds: RequestBounds): Promise<CarrierResult> {
    return this.#structuredResult(number, await session.fetchStatus(number, bounds));
  }

  #structuredResult(number: string, payload: unknown): CarrierResult {
    const result = parseUPSTrackingResponse(payload, number);
    result.tracking_url = upsTrackingUrl(number);
    result.tracking_source = 'structured-web-response';
    return result;
  }

  #renderedResult(page: string, number: string): CarrierResult {
    const result = parseUPSTrackingHtml(page, number);
    result.tracking_url = upsTrackingUrl(number);
    result.tracking_source = 'rendered-page';
    return result;
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new UPSTracker({
    fetcher: environment.fetcher,
    trawl: environment.trawl,
    recorder: environment.recorder,
  });
  return {
    id: 'ups',
    // `direct` is plain HTTP and runs only without a browser service. `trawl`
    // is the browser, which also reads the page's own status call.
    steps: ['direct', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
