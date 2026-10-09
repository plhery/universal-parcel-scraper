import { setTimeout as delay } from 'node:timers/promises';

import { randomBytes } from 'node:crypto';
import { load } from 'cheerio';
import { lookupBudget, type AdapterFactory, type LookupBudget, type TrackingContext } from '../../core/adapter/index.js';
import { DELIVERY_POSTCODE, deliveryPostcodeText } from '../../core/catalog/postcode.js';
import { dpdParcelNumber } from '../../core/detection/dpd.js';
import { BudgetExceededError, carrierErrorKind, ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError, UpstreamHttpError, type CarrierErrorKind, type CarrierErrorOptions } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { calendarDay, isoTime, explicitOffsetTime, zonedTime, type ParsedTime } from '../../core/time/index.js';
import { TrawlClient, decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { DPD_DE_SESSION_OPENING, sharedDpdAppService, type DpdParcelShop } from '../dpd-de/service.js';
import {
  API_LABELS, PROOF_OF_DELIVERY_SCAN, apiStage, apiStatus, scanStage, wordingStatus,
} from './status.js';

// Protocol provenance:
// - The myDPD Android application talks to a guest JSON API: a Firebase
//   installation identifies the app, Remote Config hands out the guest Basic
//   credential, that credential buys a client-credentials access token, and the
//   token reads `/v10/parcels/details/<number>`. Every value below is shipped
//   publicly in the application; none of it is an account secret.
// - The delivery postcode is optional. With it, DPD unlocks verified scans and
//   the delivery window; without it the lookup continues with
//   `continueWithoutVerification=true`. A rejected postcode (HTTP 400) is
//   retried once without verification and reported as unverified rather than
//   failing the lookup. DPD answers a postcode of another country's shape the
//   same way as a wrong one, and types the refusal `PROVIDE_ZIP_CODE`.
// - DPD answers a number it has no parcel for with a details 404, or a 400
//   typed `PARCEL_NOT_FOUND`. The 400 settles it only without a postcode: a
//   real parcel looked up that way returns its history.
// - The consignee web page is the fallback when the guest API is inconclusive,
//   except HTTP 503: the service is down, irrespective of the parcel number.
//   It sits behind Cloudflare, so it is fetched through the browser service's
//   legacy command API when one is configured and directly otherwise.
const TRACKING_BASE = 'https://www.dpdgroup.com/ch/mydpd/my-parcels/incoming';
const FETCH_BASE = 'https://www.dpdgroup.com/ch/mydpd/my-parcels/track';
const API_BASE = 'https://www.dpdgroup.com/concept/webservice';
const OAUTH_URL = `${API_BASE}/oauth/token?grant_type=client_credentials`;
const DETAILS_BASE = `${API_BASE}/v10/parcels/details`;
const FIREBASE_PROJECT = 'consignee-portal';
const FIREBASE_PROJECT_NUMBER = '959401347543';
const FIREBASE_APP_ID = '1:959401347543:android:8d1a84133332291109e392';
// Public, app-restricted identifier shipped in the myDPD Android application.
const FIREBASE_API_KEY = 'AIzaSyDHMkUNUyUwFrQzKJhdC_J-L7QEwNUzwrc'; // gitleaks:allow
const ANDROID_PACKAGE = 'com.dpdgroup.chatbot.lemny.prod';
const ANDROID_CERT = '3872ACD98DE975F69C68CAF5119A5A1B2024B873';
const CLIENT_VERSION = '3.79.14';
const INSTALLATIONS_URL = `https://firebaseinstallations.googleapis.com/v1/projects/${FIREBASE_PROJECT}/installations`;
const REMOTE_CONFIG_URL = `https://firebaseremoteconfig.googleapis.com/v1/projects/${FIREBASE_PROJECT_NUMBER}/namespaces/firebase:fetch`;
const TIMEZONE = 'Europe/Zurich';
const DEFAULT_TIMEOUT_MS = 90_000;
/** How long a failed guest login answers new lookups before the next attempt. */
const TOKEN_FAILURE_MEMORY_MS = 30_000;
/** The browser service may spend the whole request timeout plus its own transport allowance. */
const SOLVER_ALLOWANCE_MS = 15_000;
const MAX_BYTES = 10_000_000;
/** Left to a lookup that waited for its pickup shop's address, to answer without it. */
const SHOP_RESERVE_MS = 5_000;

/** Cloudflare interrupted the consignee page with an interactive challenge. */
export class DPDChallengeError extends ChallengeError {
  constructor(message = 'DPD returned a Cloudflare browser challenge', options?: CarrierErrorOptions) {
    super('DPD', message, options);
    this.name = 'DPDChallengeError';
  }
}

/**
 * The guest API answered, but the answer proves nothing about the shipment
 * (unreachable, malformed, unauthenticated, or an HTTP status the guest flow
 * handles itself, except HTTP 503). The rendered page is allowed to recover from it.
 */
export class DPDAPIError extends IndeterminateError {
  constructor(message: string, options?: CarrierErrorOptions) {
    super('DPD guest API', message, options);
    this.name = 'DPDAPIError';
  }
}

/** DPD positively reports that it does not know the parcel number. */
export class DPDTrackingError extends NotFoundError {
  constructor(options?: CarrierErrorOptions) {
    super('DPD', 'DPD could not locate the shipment', options);
    this.name = 'DPDTrackingError';
  }
}

class DPDAPIHttpError extends DPDAPIError {
  /** Always present for HTTP errors; narrowed from the optional base field. */
  declare readonly status: number;
  /** The `exceptionType` the guest API names in a refusal's JSON body, or ''. */
  readonly exceptionType: string;

  constructor(status: number, exceptionType = '') {
    super(`DPD guest API returned HTTP ${status}`, { status });
    this.name = 'DPDAPIHttpError';
    this.exceptionType = exceptionType;
  }
}

/** The refusal's `exceptionType` (`PARCEL_NOT_FOUND`, `PROVIDE_ZIP_CODE`…), or '' for any other body. */
function exceptionType(bytes: Uint8Array): string {
  let body: unknown;
  try {
    body = parseJsonBytes(bytes, 'DPD guest API');
  } catch {
    return '';
  }
  const type = isRecord(body) ? body.exceptionType : undefined;
  return typeof type === 'string' && /^[A-Z][A-Z_]{0,63}$/.test(type) ? type : '';
}

/**
 * The rendered page recovers exactly what the guest API path used to hand it:
 * an inconclusive answer, a transport failure, or a payload that did not match
 * the request. A positive "unknown parcel" ends the lookup instead.
 */
const PAGE_RECOVERS = new Set<CarrierErrorKind>(['indeterminate', 'transport', 'schema']);

/**
 * Local to this adapter: the guest API mixes strings and numbers in the fields
 * we project, and its labels are not length-capped here (they are capped at the
 * projection site instead), so `core/transport`'s string-only `clean` would
 * change what a numeric city or code normalizes to. Anything else (objects,
 * arrays, booleans) is empty: `String()` of an object is "[object Object]".
 */
function clean(value: unknown): string {
  const text = textual(value);
  return text === undefined ? '' : String(text).trim().split(/\s+/).filter(Boolean).join(' ');
}

/**
 * The value when `clean` can read it, otherwise undefined, so a `??` chain
 * passes over an object as it does over null. An empty string still stops the
 * chain: stored events are keyed on what that chain produced.
 */
function textual(value: unknown): string | number | undefined {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
    ? value
    : undefined;
}

/** What DPD writes where it has no value, e.g. `country: "UNDEFINED"` on customs scans. */
const PLACEHOLDERS = new Set(['UNDEFINED', 'UNKNOWN', 'NULL', 'NONE', 'N/A', '-']);

/** Provider text with DPD's placeholders read as empty. */
function known(value: unknown): string {
  const text = clean(value);
  return PLACEHOLDERS.has(text.toUpperCase()) ? '' : text;
}

/** The first candidate that carries real text. */
function firstText(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const text = known(candidate);
    if (text) return text;
  }
  return '';
}

function optionalText(value: unknown): string | null {
  return clean(value) || null;
}

/** A guest API code (`DEY`, `PARCEL_HANDED`) fit to travel as `provider_code`, or ''. */
function scanCode(value: unknown): string {
  const code = known(value).toUpperCase().replaceAll(' ', '_');
  return /^[A-Z0-9_]{1,40}$/.test(code) ? code : '';
}

export function dpdTrackingUrl(trackingNumber: string, language?: string): string {
  const url = new URL(TRACKING_BASE);
  url.searchParams.set('parcelNumber', trackingNumber);
  if (language) url.searchParams.set('lang', language);
  return url.toString();
}

/** Page timestamps are Swiss wall-clock without an offset; unparsable values stay raw. */
function eventTime(date: string, clock: string): string {
  const value = `${date} ${clock}`.trim();
  const formats = clock
    ? ['dd.MM.yyyy HH:mm:ss', 'dd.MM.yyyy HH:mm', 'dd.MM.yyyy']
    : ['dd.MM.yyyy'];
  for (const format of formats) {
    const parsed = zonedTime(value, format, TIMEZONE);
    if (parsed) return parsed.iso;
  }
  return value;
}

function apiDescription(value: unknown): string {
  const key = clean(value).toUpperCase().replaceAll(' ', '_');
  return API_LABELS[key] ?? key.toLocaleLowerCase('en-US')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function apiSender(payload: JsonObject, current: JsonObject): string | null {
  // Webshop sender only; recipient names stay out. A verified lookup sends
  // `sender` as an object with a company, a name, an id and a postal address:
  // only the company, then the name, is read. The `receiver` block never is.
  const sender = isRecord(payload.sender) ? payload.sender : {};
  const value = firstText(
    sender.companyName, sender.name, payload.senderName, payload.sender, current.senderName,
  );
  return value ? value.slice(0, 200) : null;
}

function apiPickupPoint(payload: JsonObject, current: JsonObject, stage: string | null): string | null {
  if (stage !== 'ready_for_pickup') return null;
  // ParcelShop collection points are operational locations, not private
  // addresses. The receiver's name is not one: it names the recipient.
  const value = firstText(
    ...[current.pickupPoint, current.parcelShop, payload.pickupPoint, payload.parcelShop]
      .map((candidate) => (isRecord(candidate) ? firstText(candidate.name, candidate.shopName) : candidate)),
  );
  return value ? value.slice(0, 200) : null;
}

/** Scans at DPD's depots and hubs. */
const DEPOT_SCANS = new Set(['ORI', 'SPL', 'HUI', 'HUS', 'DLI', 'DLS', 'DLQ', 'DLO']);

/**
 * The PUDO id of the shop the parcel waits at: that of the newest scan naming
 * one, unless a depot scan came after it, as after the sender's drop-off at a
 * shop. Verified replies only: `parcelHistory` names no shop.
 */
function pickupShopId(payload: JsonObject): string {
  const scans = (Array.isArray(payload.parcelEvents) ? payload.parcelEvents.filter(isRecord) : [])
    .map((raw, index) => ({ raw, index, wallClock: `${clean(raw.date)}T${clean(raw.time)}` }))
    .sort((left, right) => right.wallClock.localeCompare(left.wallClock) || left.index - right.index);
  for (const { raw } of scans) {
    const id = clean(raw.pudoId);
    if (/^[A-Z]{2}\d{1,12}$/.test(id)) return id;
    if (DEPOT_SCANS.has(scanCode(raw.eventType))) return '';
  }
  return '';
}

function apiLocation(event: JsonObject): string {
  const city = known(event.city);
  // A scan's own `country` wins even when it is a placeholder: `depotCountry`
  // names the business unit's depot on every scan, customs and paperwork scans
  // included. It stays the last fallback for a scan that names no country at
  // all, as it always was, so places stored from such scans keep their identity.
  const country = known(textual(event.country) ?? textual(event.countryCode) ?? textual(event.depotCountry));
  return city && country && city.toLocaleLowerCase('en-US') !== country.toLocaleLowerCase('en-US')
    ? `${city}, ${country}`
    : city || country;
}

/**
 * A scan's `eventDateAndTimeZoneId` as a zone luxon reads. DPD sends "+02:00"
 * and "Europe/Zurich"; "+0200", "UTC+2", "Z", "UTC" and "GMT" are accepted
 * too. Anything else passes through, and an unreadable zone means Swiss time.
 */
function scanZone(value: unknown): string {
  const text = clean(value);
  if (/^(?:Z|UTC|GMT)$/i.test(text)) return 'UTC';
  const offset = /^(?:UTC|GMT)?([+-])(\d{1,2}):?(\d{2})?$/i.exec(text);
  if (!offset) return text;
  const [, sign, hours, minutes = '00'] = offset;
  return Number(hours) <= 14 && Number(minutes) < 60 ? `UTC${sign}${hours!.padStart(2, '0')}:${minutes}` : '';
}

/** How this adapter read a zone id before `scanZone`; stored events carry its spelling. */
function storedTime(value: string, zoneId: unknown): ParsedTime | null {
  const zoneText = clean(zoneId);
  const zone = /^[+-]\d{2}:\d{2}$/.test(zoneText) ? `UTC${zoneText}` : zoneText || TIMEZONE;
  return isoTime(value, zone) ?? (zoneText ? isoTime(value, TIMEZONE) : null);
}

/**
 * Guest API timestamps: an explicit offset wins, then the zone DPD names for
 * that scan, then Swiss time. Unparsable values keep their raw text.
 *
 * The sync keys stored events on this exact string. When the instant is the
 * one the adapter read before (with `storedZoneId`, Swiss time for
 * `parcelEvents`), the earlier spelling is returned so no stored scan is
 * duplicated.
 */
function apiEventTime(
  date: unknown,
  clock: unknown = '',
  zoneId: unknown = null,
  storedZoneId: unknown = zoneId,
): string {
  const dateText = clean(date);
  const clockText = clean(clock);
  const value = clockText ? `${dateText}T${clockText}` : dateText;
  if (!value) return '';
  const offsetParsed = explicitOffsetTime(value);
  if (offsetParsed) return offsetParsed.iso;
  const zone = scanZone(zoneId);
  const parsed = (zone ? isoTime(value, zone) : null) ?? isoTime(value, TIMEZONE);
  const stored = storedTime(value, storedZoneId);
  return (stored && stored.timestamp === parsed?.timestamp ? stored : parsed)?.iso
    ?? clean(`${dateText} ${clockText}`);
}

/** The parcel weight in kilograms; absent, zero and implausible values are dropped. */
function apiWeight(value: unknown): number | null {
  const text = clean(value).replace(',', '.');
  const weight = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
  return Number.isFinite(weight) && weight > 0 && weight < 10_000 ? weight : null;
}

function expectedDelivery(payload: JsonObject): string | null {
  const rawDate = clean(payload.deliveryDate);
  if (!rawDate) return null;
  const date = /^\d{4}-\d{2}-\d{2}/.exec(rawDate)?.[0] ?? rawDate;
  const shortTime = (value: unknown) => /^(\d{2}:\d{2})/.exec(clean(value))?.[1] ?? '';
  const from = shortTime(payload.deliveryTimeFrom);
  const to = shortTime(payload.deliveryTimeTo);
  if (from && to) return `${date} ${from}–${to}`;
  return from || to ? `${date} ${from || to}` : date;
}

/** Scans in which DPD states a delivery day: an estimate, a changed date or the email notice. */
const DELIVERY_NOTICE = /\b(?:estimated to be|will be) delivered on\b/i;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december'];

/** A notice clock as 24-hour `HH:mm`; it stays the recipient's wall clock. */
function noticeClock(text: string | undefined): string | null {
  const match = /^(\d{1,2}):([0-5]\d)(?:\s*([AP])M)?$/i.exec(text ?? '');
  if (!match) return null;
  const hour = Number(match[1]);
  const half = match[3]?.toUpperCase();
  if (half ? hour < 1 || hour > 12 : hour > 23) return null;
  return `${String(half ? (hour % 12) + (half === 'P' ? 12 : 0) : hour).padStart(2, '0')}:${match[2]}`;
}

/** "…delivered on: Thursday, July 16, 2026", optionally followed by "between 9:00 AM and 12:00 PM". */
function noticeEstimate(text: string): string | null {
  const match = /\bdelivered on:?\s+(?:[a-z]+,\s*)?([a-z]+)\s+(\d{1,2}),\s*(\d{4})(?:\s+between\s+(\d{1,2}:\d{2}(?:\s*[AP]M)?)\s+and\s+(\d{1,2}:\d{2}(?:\s*[AP]M)?))?/i.exec(text);
  const month = match ? MONTHS.indexOf(match[1]!.toLowerCase()) + 1 : 0;
  const day = match && month ? calendarDay(Number(match[3]), month, Number(match[2])) : null;
  if (!match || !day) return null;
  const from = noticeClock(match[4]);
  const to = noticeClock(match[5]);
  return from && to && from <= to ? `${day} ${from}–${to}` : day;
}

/**
 * Newest scan first. The guest API has listed a parcel's scans oldest first,
 * and the summary and freshness watermark read the first event. Equal or
 * unreadable times keep the payload's order.
 */
function newestFirst(events: CarrierEvent[]): CarrierEvent[] {
  return events
    .map((event, index) => ({ event, index, timestamp: Date.parse(event.time ?? '') || 0 }))
    .sort((left, right) => right.timestamp - left.timestamp || left.index - right.index)
    .map(({ event }) => event);
}

export function parseDPDTrackingApi(
  payload: unknown,
  trackingNumber: string,
  postcodeVerified?: boolean,
): CarrierResult {
  if (!isRecord(payload)) throw new DPDAPIError('DPD guest API returned an invalid response');
  if (clean(payload.parcelNumber ?? payload.shipmentId) !== trackingNumber) {
    throw new SchemaError('DPD', 'DPD did not return the requested parcel');
  }
  const history = Array.isArray(payload.parcelHistory) ? payload.parcelHistory.filter(isRecord) : [];
  // A verified lookup lists each movement twice: in `parcelEvents` with its
  // wording, place and scan code but a bare Swiss wall clock, and in
  // `parcelHistory` with the enumeration and DPD's offset for that scan. A
  // scan takes the offset of the history entry at the same wall clock, so the
  // repeated autumn hour keeps its instant; without one it is read in Swiss time.
  // Only a scan alone at its wall clock with a single entry there is paired
  // and lent that entry's stage. Otherwise nothing says which entry is whose:
  // the scans share an offset only when every entry there names the same zone.
  const parcelEvents = Array.isArray(payload.parcelEvents) ? payload.parcelEvents.filter(isRecord) : [];
  const scanWallClock = (raw: JsonObject) => `${clean(raw.date)}T${clean(raw.time)}`;
  const entriesAt = new Map<string, JsonObject[]>();
  for (const raw of history) {
    const wallClock = clean(raw.eventDateAndTime).slice(0, 19);
    if (wallClock) entriesAt.set(wallClock, [...(entriesAt.get(wallClock) ?? []), raw]);
  }
  const scansAt = new Map<string, number>();
  for (const raw of parcelEvents) {
    const wallClock = scanWallClock(raw);
    scansAt.set(wallClock, (scansAt.get(wallClock) ?? 0) + 1);
  }
  const scans: CarrierEvent[] = [];
  const seen = new Set<string>();
  const append = (event: CarrierEvent) => {
    const key = JSON.stringify([event.time ?? '', event.location ?? '', event.description ?? '']);
    if (!seen.has(key)) {
      seen.add(key);
      scans.push(event);
    }
  };
  // Only the fields below leave a scan. `podUrl` embeds the parcel number, and
  // `pudoId`, `buShortName` and `depotCountry` are DPD's own routing data: a
  // scan's `pudoId` only finds the address of the shop holding the parcel.
  for (const raw of parcelEvents) {
    const code = scanCode(raw.eventType);
    const wallClock = scanWallClock(raw);
    const entries = entriesAt.get(wallClock) ?? [];
    const twin = entries.length === 1 && scansAt.get(wallClock) === 1 ? entries[0] : undefined;
    const zoneId = new Set(entries.map((entry) => clean(entry.eventDateAndTimeZoneId))).size === 1
      ? entries[0]?.eventDateAndTimeZoneId
      : null;
    const stage = scanStage(code) ?? apiStage(code) ?? (twin ? apiStage(twin.description) : null);
    append({
      time: apiEventTime(raw.date, raw.time, zoneId, null),
      location: apiLocation(raw),
      description: clean(textual(raw.translation) ?? textual(raw.eventTypeText) ?? apiDescription(raw.eventType))
        || 'Tracking update',
      ...(stage ? { stage } : {}),
      ...(code ? { provider_code: code } : {}),
    });
  }
  if (scans.length === 0) {
    for (const raw of history) {
      const code = scanCode(raw.description);
      const stage = apiStage(code);
      append({
        time: apiEventTime(raw.eventDateAndTime, '', raw.eventDateAndTimeZoneId),
        location: apiLocation(raw),
        description: apiDescription(raw.description),
        ...(stage ? { stage } : {}),
        ...(code ? { provider_code: code } : {}),
      });
    }
  }
  const current = isRecord(payload.status) ? payload.status : {};
  const currentDescription = current.description;
  const stage = apiStage(currentDescription);
  // The proof-of-delivery scan follows the delivery scan by minutes, with no
  // place. Next to it the paperwork adds nothing, and as the newest event its
  // wording, which no rule maps, would become the summary and the apps'
  // current stage. Alone it proves the delivery only when the enumeration
  // says delivered; otherwise (a return, say) it would hide the real state.
  const deliveryScanned = scans.some((event) => (
    event.stage === 'delivered' && event.provider_code !== PROOF_OF_DELIVERY_SCAN
  ));
  const events = newestFirst(scans.flatMap((event) => {
    if (event.provider_code !== PROOF_OF_DELIVERY_SCAN) return [event];
    return deliveryScanned || stage !== 'delivered' ? [] : [{ ...event, stage: 'delivered' }];
  }));
  const statusText = events[0]?.description || apiDescription(currentDescription)
    || 'Tracking information received';
  const status = apiStatus(currentDescription, statusText, events.length > 0);
  const sender = apiSender(payload, current);
  const pickupPoint = apiPickupPoint(payload, current, stage);
  const weight = apiWeight(payload.weight);
  const deliveredAt = status === 'delivered'
    ? events.find((event) => event.stage === 'delivered')?.time
    : undefined;
  // Only the newest notice counts, so an undated or unreadable one leaves no
  // older day behind. A day that a later scan has passed, or a parcel waiting
  // at a pickup point, ends the notice. The payload's own estimate wins; a
  // notice for that same day can only add the email's window.
  const notice = events.find((event) => DELIVERY_NOTICE.test(event.description ?? ''));
  const announced = notice ? noticeEstimate(notice.description ?? '') : null;
  const newestDay = /^\d{4}-\d{2}-\d{2}/.exec(events[0]?.time ?? '')?.[0];
  const forecast = announced && stage !== 'ready_for_pickup' && !(newestDay && announced.slice(0, 10) < newestDay)
    ? announced : null;
  const listed = expectedDelivery(payload);
  // Never projected: `receiver` (name, contact, address, geoPosition), the
  // sender's id and address, `customerReference1/2`, `gttsZipCode`, `podUrl`
  // and `product`, which holds the recipient's delivery preference.
  const result: CarrierResult = {
    status,
    ...(stage ? { current_stage: stage } : {}),
    last_status_text: statusText,
    last_update: events[0]?.time || apiEventTime(
      current.eventDateAndTime,
      '',
      current.eventDateAndTimeZoneId,
    ) || null,
    expected_delivery: status === 'delivered' || status === 'exception' ? null
      : listed && listed !== forecast?.slice(0, 10) ? listed : forecast ?? listed,
    events,
    source: 'mydpd_guest_api',
    delivery_date: optionalText(payload.deliveryDate),
    delivery_time_from: optionalText(payload.deliveryTimeFrom),
    delivery_time_to: optionalText(payload.deliveryTimeTo),
    is_predictive_date: Boolean(payload.isPredictiveDate),
    ...(sender ? { sender_name: sender } : {}),
    ...(pickupPoint ? { pickup_point: pickupPoint } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
  };
  if (postcodeVerified !== undefined) result.dpd_postcode_verified = postcodeVerified;
  return result;
}

/** Guard automatic scope confirmation and the new German direct service. */
function requireGuestActivity(payload: JsonObject, result: CarrierResult): void {
  if (!isRecord(payload.status) || !known(payload.status.description)) {
    throw new SchemaError('DPD', 'DPD returned no usable shipment status');
  }
  const validClock = (value: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)
    && isoTime(value, 'UTC') !== null;
  for (const field of ['parcelHistory', 'parcelEvents'] as const) {
    const rows = payload[field];
    if (rows === undefined) continue;
    if (!Array.isArray(rows) || rows.length > 1_000 || rows.some((row) => !isRecord(row))) {
      throw new SchemaError('DPD', 'DPD returned invalid tracking history');
    }
    for (const row of rows.filter(isRecord)) {
      const clock = field === 'parcelHistory'
        ? known(row.eventDateAndTime) : `${known(row.date)}T${known(row.time)}`;
      const description = field === 'parcelHistory'
        ? known(row.description) : firstText(row.translation, row.eventTypeText, row.eventType);
      if (!description || !validClock(clock)) {
        throw new SchemaError('DPD', 'DPD returned an incomplete tracking event');
      }
    }
  }
  // An identity echo or a summary without activity does not establish a parcel.
  if (!result.events?.length) throw new IndeterminateError('DPD', 'DPD returned no shipment activity');
}

export function parseDPDTrackingHtml(html: string, trackingNumber: string): CarrierResult {
  if (/Just a moment|cf-mitigated|Enable JavaScript and cookies/i.test(html)) {
    throw new DPDChallengeError();
  }
  const $ = load(html);
  $('script, style').remove();
  const visible = clean($('body').text());
  if (!visible.includes(trackingNumber)) {
    throw new SchemaError('DPD', 'DPD did not return the requested parcel');
  }
  if (/no parcel|not found|nicht gefunden|aucun colis/i.test(visible)) {
    return {
      status: 'unknown',
      last_status_text: 'No parcel found',
      last_update: null,
      expected_delivery: null,
      events: [],
    };
  }
  const events: CarrierEvent[] = [];
  $('li.content-item-track').each((_, element) => {
    const row = $(element);
    const description = clean(row.find('.entry-body').text());
    if (!description) return;
    events.push({
      time: eventTime(clean(row.find('.entry-date').text()), clean(row.find('.entry-time').text())),
      location: clean(row.find('.place-track').text()),
      description,
    });
  });
  if (events.length === 0) {
    const summary: Array<{ date: string; description: string }> = [];
    $('.parcelStatus .row').each((_, element) => {
      const row = $(element);
      const date = /\d{2}\.\d{2}\.\d{4}/.exec(clean(row.text()))?.[0] ?? '';
      const description = clean(row.find('.col-xs-7').text())
        || clean(row.text()).replace(date, '').trim();
      if (date && description) summary.push({ date, description });
    });
    const offsets = new Map<string, number>();
    for (const item of summary) {
      const offset = offsets.get(item.date) ?? 0;
      offsets.set(item.date, offset + 1);
      events.push({
        time: eventTime(item.date, `00:${String(Math.floor(offset / 60)).padStart(2, '0')}:${String(offset % 60).padStart(2, '0')}`),
        location: '',
        description: item.description,
      });
    }
    events.reverse();
  }
  const labels = $('.gray-out').map((_, element) => clean($(element).text())).get().filter(Boolean);
  const statusText = events[0]?.description ?? labels.at(-1) ?? 'Tracking information received';
  return {
    status: wordingStatus(statusText, events.length > 0),
    last_status_text: statusText,
    last_update: events[0]?.time || null,
    expected_delivery: null,
    events,
  };
}

function durationSeconds(value: unknown, fallback: number): number {
  const match = /^(\d+)s?$/.exec(typeof value === 'string' || typeof value === 'number' ? String(value) : '');
  return match ? Number(match[1]) : fallback;
}

/** `shared`, for as long as the lookup waiting on it is live: its own signal ends the wait, not the shared work. */
async function whileLive<T>(shared: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let leave!: () => void;
  const left = new Promise<never>((_resolve, reject) => { leave = () => reject(signal.reason); });
  signal.addEventListener('abort', leave, { once: true });
  try {
    return await Promise.race([shared, left]);
  } finally {
    signal.removeEventListener('abort', leave);
  }
}

export interface DPDTrackerOptions {
  /** Guest service country; the existing Swiss adapter remains the default. */
  country?: 'CH' | 'DE';
  timeoutMs?: number;
  /** Whole-lookup budget; defaults to both tiers plus the solver's own allowance. */
  budgetMs?: number;
  /** Legacy configuration seam kept for tests; production passes `trawl`. */
  flaresolverrUrl?: string;
  firebaseApiKey?: string;
  fetcher?: typeof fetch;
  trawl?: TrawlClient | null;
  recorder?: StepRecorder;
  userAgent?: string;
  /** A further German tier, ahead of the guest tier when no postcode is given. */
  app?: DPDAppTier;
  /** Finds the address of the Pickup shop a parcel waits at, by its PUDO id. */
  shops?: DPDParcelShops;
}

export interface DPDParcelShops {
  /** The shop, or nothing when it is not found in time; only the signal ends it with an error. */
  parcelShop(id: string, options: { signal: AbortSignal; timeoutMs: number }): Promise<DpdParcelShop | undefined>;
}

export interface DPDAppTier {
  /**
   * `leads` when the guest tier is still to come and needs time left. `postcode` is empty when none was given.
   * `waiting`, given to a leading tier, is called when the lookup starts waiting for the tier's session to open.
   * `stop` aborts when the lookup has its answer without the tier, which then reads nothing more.
   */
  run(number: string, context: {
    signal: AbortSignal; stop: AbortSignal; timeoutMs: number; leads: boolean; postcode: string; waiting?: () => void;
  }): Promise<CarrierResult>;
  /** The failures of either tier the other may answer after. */
  recovers(error: unknown): boolean;
}

export class DPDTracker {
  readonly country: 'CH' | 'DE';
  readonly timeoutMs: number;
  readonly budgetMs: number;
  readonly flaresolverrUrl: string;
  readonly firebaseApiKey: string;
  private readonly fetcher?: typeof fetch;
  private readonly trawl?: TrawlClient | null;
  private readonly recorder?: StepRecorder;
  private readonly userAgent: string;
  private readonly app?: DPDAppTier;
  private readonly shops?: DPDParcelShops;
  #accessToken = '';
  #accessTokenExpiresAt = 0;
  #basicToken = '';
  #installationFid = '';
  #installationToken = '';
  #installationExpiresAt = 0;
  #tokenRefresh: { token: Promise<string>; owner: AbortSignal } | null = null;
  #tokenFailure: { error: unknown; until: number } | null = null;

  constructor(options: DPDTrackerOptions = {}) {
    this.country = options.country ?? 'CH';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.budgetMs = options.budgetMs ?? this.timeoutMs * 2 + SOLVER_ALLOWANCE_MS;
    this.flaresolverrUrl = (options.flaresolverrUrl ?? '').trim();
    this.firebaseApiKey = (options.firebaseApiKey ?? FIREBASE_API_KEY).trim();
    this.fetcher = options.fetcher;
    this.trawl = options.trawl;
    this.recorder = options.recorder;
    this.userAgent = userAgentOf(options.userAgent);
    this.app = options.app;
    this.shops = options.shops;
  }

  /** The browser service, resolved late so a malformed URL fails the page step, not construction. */
  private browserService(): TrawlClient | null {
    if (this.trawl !== undefined) return this.trawl;
    return this.flaresolverrUrl ? new TrawlClient(this.flaresolverrUrl, this.fetcher) : null;
  }

  async fetch(raw: string, postcode = '', context: TrackingContext = {}): Promise<CarrierResult> {
    // Labels print a check character after the fourteen digits; the API takes the digits.
    const trackingNumber = dpdParcelNumber(raw);
    if (!trackingNumber) {
      throw new InvalidInputError('DPD', 'DPD tracking numbers must contain 14 digits, with or without their check character');
    }
    // DPD checks the postcode against the recipient's, and the service this
    // adapter asks also answers for parcels delivered in other countries: any
    // country's postcode goes through. The German unit reads German deliveries.
    const resolvedPostcode = deliveryPostcodeText(postcode);
    if (resolvedPostcode && !(this.country === 'DE' ? /^\d{5}$/ : DELIVERY_POSTCODE).test(resolvedPostcode)) {
      throw new InvalidInputError('DPD', this.country === 'DE'
        ? 'DPD postcode must contain exactly 5 digits'
        : 'DPD postcode must be 3 to 12 letters and digits with a digit, in groups joined by a space or hyphen');
    }
    // One signal and one clock for both tiers and the guest login they share with `recognizes`.
    const carrier = this.country === 'DE' ? 'dpd-de' : 'dpd';
    const lookup = lookupBudget(context, this.budgetMs, carrier);
    const pageRecovers = (error: unknown): boolean => {
      const kind = carrierErrorKind(error);
      return !context.signal?.aborted && kind !== null && PAGE_RECOVERS.has(kind);
    };
    const app = this.app;
    const appRecovers = (error: unknown): boolean => !context.signal?.aborted && app!.recovers(error);
    // Without a postcode the app's scans are the richer history; with one, the
    // guest tier's verified reply comes first.
    const appLeads = app !== undefined && !resolvedPostcode;
    // The guest tier's reply, kept for its step when it was asked beside the app.
    let guest: Promise<CarrierResult> | undefined;
    const guestReply = () => guest ??= this.apiFetch(trackingNumber, resolvedPostcode, lookup);
    /**
     * While the app's session opens, the guest tier is asked beside it, not
     * while a host's store gives back a saved session. A parcel the guest tier
     * does not know, or places in another country, the app does not answer
     * either: the app stops waiting, reads nothing once its session opens, and
     * the guest tier's step reports it. Otherwise the app keeps waiting, because
     * the guest tier's reply without a postcode is a summary: one entry per
     * milestone, without places, registration, repeated delivery attempts and
     * failures, or the parcel's size. Its clocks and wording also differ from
     * the app's scans, so a consumer that stored it would keep both versions of
     * a scan once a later lookup reads the app. The reply serves the guest
     * tier's step if the session does not open in time. A failed reply is
     * asked again there.
     */
    const besideGuest = (stop: AbortController): Promise<never> => {
      const reply = guestReply();
      const pending = new Promise<never>(() => {});
      return reply.then(() => pending, (error: unknown) => {
        if (!app!.recovers(error)) {
          const stopped = new IndeterminateError('DPD Germany', 'DPD Germany app session is still opening', { reason: DPD_DE_SESSION_OPENING });
          stop.abort(stopped);
          throw stopped;
        }
        if (guest === reply) guest = undefined;
        return pending;
      });
    };
    const appStep = (leads: boolean) => ({
      id: 'app',
      ...(leads ? {} : { recovers: appRecovers }),
      run: ({ signal, remainingMs }: { signal: AbortSignal; remainingMs: number }) => {
        const stop = new AbortController();
        const tier = { signal, stop: stop.signal, timeoutMs: remainingMs, leads, postcode: resolvedPostcode };
        if (!leads) return app!.run(trackingNumber, tier);
        let waiting!: () => void;
        const opening = new Promise<void>((resolve) => { waiting = resolve; });
        return Promise.race([app!.run(trackingNumber, { ...tier, waiting }), opening.then(() => besideGuest(stop))]);
      },
    });
    const result = await runSteps<CarrierResult>({
      carrier, budgetMs: lookup.budgetMs, signal: lookup.signal, recorder: this.recorder,
    }, [
      ...(appLeads ? [appStep(true)] : []),
      {
        id: 'direct',
        ...(appLeads ? { recovers: appRecovers } : {}),
        run: () => guestReply().catch((error: unknown) => {
          // The signal ends the guest tier a moment before the runner counts
          // the budget as spent: the tier reports the budget itself, so the
          // page is not entered in between.
          if (lookup.signal.aborted && pageRecovers(error)) {
            throw new BudgetExceededError(carrier, lookup.budgetMs, { cause: error });
          }
          throw error;
        }),
      },
      ...(this.country === 'CH' ? [{
        id: 'page',
        recovers: pageRecovers,
        run: ({ previousError }: { previousError?: unknown }) => this.pageFetch(trackingNumber, previousError !== undefined, lookup),
      }] : app && !appLeads ? [appStep(false)] : []),
    ]);
    result.tracking_url = this.country === 'DE'
      ? `https://tracking.dpd.de/status/en_US/parcel/${trackingNumber}`
      : dpdTrackingUrl(trackingNumber);
    return result;
  }

  /**
   * Whether the guest reply establishes activity in this tracker's country for
   * a 14-digit number. The group-wide identity match alone must not promote
   * another country's parcel to this carrier id. Missing country evidence is
   * inconclusive.
   * Guest API only, never the page tier. A positive not-found (a details 404,
   * or a 400 typed `PARCEL_NOT_FOUND`) is false; any other failure, another
   * 400 included, stays a failure.
   */
  async recognizes(raw: string, context: TrackingContext = {}): Promise<boolean> {
    const trackingNumber = dpdParcelNumber(raw);
    if (!trackingNumber) return false;
    const lookup = lookupBudget(context, this.budgetMs, this.country === 'DE' ? 'dpd-de' : 'dpd');
    try {
      const payload = await this.detailsWithFreshToken(trackingNumber, undefined, lookup);
      if (clean(payload.parcelNumber ?? payload.shipmentId) !== trackingNumber) return false;
      const current = isRecord(payload.status) ? payload.status : {};
      const country = known(current.countryCode).toUpperCase();
      if (/^[A-Z]{2}$/.test(country) && country !== this.country) return false;
      if (country !== this.country) {
        throw this.country === 'DE'
          ? new IndeterminateError('DPD Germany', 'DPD returned no German country evidence')
          : new IndeterminateError('DPD Switzerland', 'DPD returned no Swiss country evidence');
      }
      requireGuestActivity(payload, parseDPDTrackingApi(payload, trackingNumber));
      return true;
    } catch (error) {
      if (error instanceof DPDTrackingError) return false;
      throw error;
    }
  }

  private async apiFetch(trackingNumber: string, postcode: string, lookup: LookupBudget): Promise<CarrierResult> {
    let postcodeVerified: boolean | undefined;
    let payload: JsonObject;
    try {
      payload = await this.detailsWithFreshToken(trackingNumber, postcode || undefined, lookup);
      if (postcode) postcodeVerified = true;
    } catch (error) {
      if (!(error instanceof DPDAPIHttpError) || !postcode || error.status !== 400) throw error;
      payload = await this.detailsWithFreshToken(trackingNumber, undefined, lookup);
      postcodeVerified = false;
    }
    const result = parseDPDTrackingApi(payload, trackingNumber, postcodeVerified);
    const shopId = this.shops && result.current_stage === 'ready_for_pickup' ? pickupShopId(payload) : '';
    if (shopId) {
      // The reply names the shop, if at all, without its address: the shop's own
      // record adds it. Without the record the result stays as it was.
      const shop = await this.pickupShop(shopId, lookup);
      const name = result.pickup_point || shop?.name.slice(0, 200);
      if (shop && name) result.pickup_point = `${name}\n${shop.address}`;
    }
    // The guest service can answer for another business unit. A selected
    // German adapter must not project explicit evidence for another country.
    if (this.country === 'DE' && isRecord(payload.status)) {
      const country = known(payload.status.countryCode).toUpperCase();
      if (/^[A-Z]{2}$/.test(country) && country !== 'DE') {
        throw new IndeterminateError('DPD Germany', 'DPD returned activity in another country', { reason: 'other_country' });
      }
    }
    if (this.country === 'DE') requireGuestActivity(payload, result);
    return result;
  }

  /** The shop's record, within the budget less a moment for the lookup to answer without it. */
  private async pickupShop(id: string, lookup: LookupBudget): Promise<DpdParcelShop | undefined> {
    const timeoutMs = Math.min(this.timeoutMs, lookup.remainingMs()) - SHOP_RESERVE_MS;
    return timeoutMs > 0 ? this.shops!.parcelShop(id, { signal: lookup.signal, timeoutMs }) : undefined;
  }

  private async detailsWithFreshToken(trackingNumber: string, postcode: string | undefined, lookup: LookupBudget): Promise<JsonObject> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.accessToken(lookup);
      try {
        return await this.parcelDetails(trackingNumber, postcode, token, lookup);
      } catch (error) {
        if (!(error instanceof DPDAPIHttpError) || error.status !== 401 || attempt > 0) throw error;
        this.#accessToken = '';
        this.#accessTokenExpiresAt = 0;
      }
    }
    throw new DPDAPIError('DPD guest API authentication failed');
  }

  private async parcelDetails(
    trackingNumber: string,
    postcode: string | undefined,
    token: string,
    lookup: LookupBudget,
  ): Promise<JsonObject> {
    const url = new URL(`${DETAILS_BASE}/${encodeURIComponent(trackingNumber)}`);
    url.searchParams.set('parcelType', 'INCOMING');
    url.searchParams.set('businessUnit', `DPD-${this.country}`);
    url.searchParams.set('lang', 'en');
    url.searchParams.set('continueWithoutVerification', postcode ? 'false' : 'true');
    if (postcode) url.searchParams.set('dataForVerification', postcode);
    try {
      return await this.requestJson(url, '', {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': `myDPD/${CLIENT_VERSION} (Android)`,
      }, lookup, true);
    } catch (error) {
      // With a postcode, a 400 can be the postcode's refusal: `apiFetch` asks again without it.
      if (error instanceof DPDAPIHttpError && (error.status === 404
        || (error.status === 400 && !postcode && error.exceptionType === 'PARCEL_NOT_FOUND'))) {
        throw new DPDTrackingError();
      }
      throw error;
    }
  }

  private async accessToken(lookup: LookupBudget): Promise<string> {
    for (;;) {
      if (this.#accessToken && Date.now() < this.#accessTokenExpiresAt) return this.#accessToken;
      // Concurrent lookups share one refresh and its outcome. A failed guest
      // login is answered from memory for a short while, so a queue of lookups
      // during an outage does not replay the whole token chain one by one.
      // The refresh runs on the signal and budget of the lookup that started
      // it. Cut short by those, it proves nothing about DPD: it is not
      // remembered, and a lookup that shared it logs in itself.
      const shared = this.#tokenRefresh;
      if (shared) {
        try {
          return await whileLive(shared.token, lookup.signal);
        } catch (error) {
          if (lookup.signal.aborted) throw new DPDAPIError('DPD guest API is unreachable', { cause: error });
          if (!shared.owner.aborted) throw error;
          continue;
        }
      }
      if (this.#tokenFailure && Date.now() < this.#tokenFailure.until) throw this.#tokenFailure.error;
      const token = this.refreshAccessToken(lookup).then((value) => {
        this.#tokenFailure = null;
        return value;
      }, (error: unknown) => {
        if (!lookup.signal.aborted) this.#tokenFailure = { error, until: Date.now() + TOKEN_FAILURE_MEMORY_MS };
        throw error;
      }).finally(() => { this.#tokenRefresh = null; });
      this.#tokenRefresh = { token, owner: lookup.signal };
      return await token;
    }
  }

  private async refreshAccessToken(lookup: LookupBudget): Promise<string> {
    let payload: JsonObject | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const basicToken = this.#basicToken || await this.fetchBasicToken(lookup);
      try {
        payload = await this.requestJson(OAUTH_URL, '', {
          Authorization: `Basic ${basicToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': `myDPD/${CLIENT_VERSION} (Android)`,
        }, lookup);
        break;
      } catch (error) {
        if (!(error instanceof DPDAPIHttpError)
          || ![400, 401].includes(error.status)
          || attempt > 0) throw error;
        this.#basicToken = '';
      }
    }
    const token = clean(payload?.access_token);
    if (!token) throw new DPDAPIError('DPD guest API did not issue an access token');
    this.#accessToken = token;
    this.#accessTokenExpiresAt = Date.now()
      + Math.max(1, durationSeconds(payload?.expires_in, 3_600) - 60) * 1_000;
    return token;
  }

  private async fetchBasicToken(lookup: LookupBudget): Promise<string> {
    if (!this.firebaseApiKey) throw new DPDAPIError('DPD Firebase client configuration is missing');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [fid, installationToken] = await this.firebaseInstallation(lookup);
      try {
        const payload = await this.requestJson(REMOTE_CONFIG_URL, {
          appId: FIREBASE_APP_ID,
          appInstanceId: fid,
          appInstanceIdToken: installationToken,
          languageCode: 'en-US',
          countryCode: this.country,
          platformVersion: '36',
          appVersion: CLIENT_VERSION,
          packageName: ANDROID_PACKAGE,
          sdkVersion: '22.1.2',
          analyticsUserProperties: {},
        }, this.firebaseHeaders({ 'X-Goog-Firebase-Installations-Auth': installationToken }), lookup);
        const entries = isRecord(payload.entries) ? payload.entries : {};
        const token = clean(entries.basic_dpd_token);
        if (!token) throw new DPDAPIError('myDPD Remote Config omitted its guest credential');
        this.#basicToken = token;
        return token;
      } catch (error) {
        if (!(error instanceof DPDAPIHttpError)
          || ![401, 403].includes(error.status)
          || attempt > 0) throw error;
        this.#installationFid = '';
        this.#installationToken = '';
        this.#installationExpiresAt = 0;
      }
    }
    throw new DPDAPIError('myDPD Remote Config authentication failed');
  }

  private async firebaseInstallation(lookup: LookupBudget): Promise<[string, string]> {
    if (this.#installationFid
      && this.#installationToken
      && Date.now() < this.#installationExpiresAt) {
      return [this.#installationFid, this.#installationToken];
    }
    const bytes = randomBytes(17);
    bytes[0] = 0x70 | (bytes[0]! & 0x0f);
    const fid = bytes.toString('base64url').slice(0, 22);
    const payload = await this.requestJson(INSTALLATIONS_URL, {
      fid,
      appId: FIREBASE_APP_ID,
      authVersion: 'FIS_v2',
      sdkVersion: 'a:18.0.0',
    }, this.firebaseHeaders(), lookup);
    const auth = isRecord(payload.authToken) ? payload.authToken : {};
    const token = clean(auth.token);
    if (!token) throw new DPDAPIError('Firebase did not issue a myDPD installation token');
    this.#installationFid = clean(payload.fid) || fid;
    this.#installationToken = token;
    this.#installationExpiresAt = Date.now()
      + Math.max(1, durationSeconds(auth.expiresIn, 604_800) - 300) * 1_000;
    return [this.#installationFid, token];
  }

  private firebaseHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': this.firebaseApiKey,
      'X-Android-Package': ANDROID_PACKAGE,
      'X-Android-Cert': ANDROID_CERT,
      'User-Agent': this.userAgent,
      ...extra,
    };
  }

  private async requestJson(
    url: string | URL,
    data: JsonObject | string,
    headers: Record<string, string>,
    lookup: LookupBudget,
    retryRead = false,
  ): Promise<JsonObject> {
    // The request keeps its own timeout; the lookup's signal alone ends it at
    // the budget. A failure with that signal aborted is then the lookup's doing,
    // not DPD's, which is what the token refresh and the `direct` step need to
    // tell apart.
    const deadline = performance.now() + this.timeoutMs;
    let result;
    try {
      for (let attempt = 0; ; attempt++) {
        result = await fetchBounded(url, {
          method: 'POST',
          headers,
          body: typeof data === 'string' ? data : JSON.stringify(data),
          signal: lookup.signal,
        }, {
          provider: 'DPD guest API',
          timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
          maxBytes: MAX_BYTES,
          allowHttpError: true,
          fetcher: this.fetcher,
        });
        // Only the read-only parcel-details POST is replayed; auth requests are not.
        const pause = 1_000 + Math.floor(Math.random() * 2_000);
        const retryAfter = result.response.headers.get('retry-after');
        if (!retryRead || attempt > 0 || ![502, 503, 504].includes(result.response.status)
          || retryAfter !== null || Math.min(deadline, lookup.deadline) - performance.now() < pause + 1_000) break;
        await delay(pause, undefined, { signal: lookup.signal });
      }
    } catch (error) {
      throw new DPDAPIError('DPD guest API is unreachable', { cause: error });
    }
    // A 503 describes DPD's availability, so the page must not turn it into
    // an answer about the parcel or hold up the caller's other lookups.
    if (result.response.status === 503) throw new UpstreamHttpError('DPD guest API', 503);
    if (!result.response.ok) throw new DPDAPIHttpError(result.response.status, exceptionType(result.bytes));
    let payload: unknown;
    try {
      payload = parseJsonBytes(result.bytes, 'DPD guest API');
    } catch (error) {
      throw new DPDAPIError('DPD guest API returned invalid JSON', { cause: error });
    }
    if (!isRecord(payload)) throw new DPDAPIError('DPD guest API returned an invalid response');
    return payload;
  }

  private async pageFetch(trackingNumber: string, apiFailed: boolean, lookup: LookupBudget): Promise<CarrierResult> {
    const url = new URL(FETCH_BASE);
    url.searchParams.set('lang', 'en');
    url.searchParams.set('parcelNumber', trackingNumber);
    const trawl = this.browserService();
    let html: string;
    if (trawl) {
      html = await trawl.solve(url.toString(), {
        provider: 'The browser challenge solver',
        timeoutMs: Math.min(this.timeoutMs, lookup.remainingMs()),
        maxBytes: MAX_BYTES,
        fetcher: this.fetcher,
        signal: lookup.signal,
      });
    } else {
      try {
        html = await this.directGet(url, lookup);
      } catch (error) {
        if (!(error instanceof DPDChallengeError)) throw error;
        const prefix = apiFailed ? 'DPD guest API is unavailable and ' : 'DPD ';
        throw new DPDChallengeError(
          `${prefix}the web fallback requires a browser challenge solver; configure FLARESOLVERR_URL`,
          { cause: error },
        );
      }
    }
    return parseDPDTrackingHtml(html, trackingNumber);
  }

  private async directGet(url: URL, lookup: LookupBudget): Promise<string> {
    const result = await fetchBounded(url, {
      signal: lookup.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-CH,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
      },
    }, {
      provider: 'DPD',
      timeoutMs: Math.min(this.timeoutMs, lookup.remainingMs()),
      maxBytes: MAX_BYTES,
      redirect: 'follow',
      allowHttpError: true,
      fetcher: this.fetcher,
    });
    const html = decodeText(result.bytes);
    if (result.response.status === 403
      && (result.response.headers.get('cf-mitigated') === 'challenge'
        || /Just a moment|Enable JavaScript and cookies/i.test(html))) {
      throw new DPDChallengeError();
    }
    if (!result.response.ok) throw new IndeterminateError('DPD', `DPD returned HTTP ${result.response.status}`);
    return html;
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DPDTracker({
    fetcher: environment.fetcher,
    trawl: environment.trawl,
    recorder: environment.recorder,
    userAgent: environment.userAgent,
    // A host can follow a rotated key without waiting for a release.
    firebaseApiKey: environment.env.DPD_FIREBASE_API_KEY?.trim() || undefined,
    // The German DPD app's service holds the group's Pickup shops, Swiss ones included.
    // Its session is the process's, which DPD Germany shares.
    shops: sharedDpdAppService(environment),
  });
  return {
    id: 'dpd',
    // The guest JSON protocol first; the Cloudflare-protected consignee page,
    // solved by the browser service when one is configured, second.
    steps: ['direct', 'page'],
    track: (input, context) => tracker.fetch(input.number, input.postcode ?? '', context),
    recognize: async (number, context) => ({ known: await tracker.recognizes(number, context) }),
  };
};
