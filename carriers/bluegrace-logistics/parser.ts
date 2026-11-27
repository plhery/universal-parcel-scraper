import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode, isoTime, usStateTimeZone } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { otherRegionZones } from '../../places/zones.js';
import { bluegraceStage } from './status.js';

export const PROVIDER = 'BlueGrace Logistics';
// A shipment's reply is a few kilobytes; a PRO number shared by a few shipments a few more.
export const BLUEGRACE_MAX_BYTES = 512 * 1024;
// The tracking page is about 70 kilobytes.
export const BLUEGRACE_PAGE_MAX_BYTES = 1024 * 1024;

/** The two references the tracker looks a shipment up by: BlueGrace's bill of lading, or the carrier's PRO number. */
export type BluegraceReference = 'BOL' | 'PRO';

// BlueGrace's bills of lading are BG and nine digits; carriers' PRO numbers are digits, some with letters.
const NUMBER = /^(?=.*\d)[A-Z0-9]{5,30}$/;
// The settings the tracking page's script reads its lookup's nonce from.
const SETTINGS = /\bvar\s+bluegraceTracking\s*=\s*(\{[^;<]{0,400}\})\s*;/g;
const NONCE = /^[0-9a-f]{10}$/;
// Bot checks Cloudflare, which fronts the site, could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access denied)/i;
// A clock as the reply writes it: a wall time to the second, without a zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?$/;
const CODE = /^[A-Z0-9]{2}$/;
// The record BlueGrace keeps for its integration tests, which is no shipment.
const TEST_UNIT = 'integrationtest';
// The rows that date a forecast rather than a scan: the estimated delivery and the delivery appointment.
const FORECASTS = new Set(['AG', 'AB']);
// En route to the delivery location: out for delivery once in the consignee's state, as the tracking page reads it.
const EN_ROUTE = 'X6';
// The shipment delayed, whose late reason says why.
const DELAYED = 'SD';
// The late reason of a row that reports none.
const NORMAL_STATUS = 'NS';
// The carriers in the catalog that BlueGrace books, by their Standard Carrier Alpha Code.
const CARRIERS: Readonly<Record<string, string>> = {
  AACT: 'aaa-cooper', ABFS: 'abf-freight', AVRT: 'averitt', CNWY: 'xpo-ltl', CTII: 'central-transport',
  DAFG: 'dayton-freight', EXLA: 'estes', FXFE: 'fedex-freight', FXNL: 'fedex-freight', OAKH: 'oak-harbor',
  ODFL: 'old-dominion', PITD: 'pitt-ohio', PYLE: 'a-duie-pyle', RNLO: 'rl-carriers', SAIA: 'saia',
  SEFL: 'southeastern-freight-lines', UPGF: 'tforce-freight', WARD: 'ward-trucking',
};
const PRO = /^[A-Z0-9]{4,30}$/;
// A zone that dates a row more than this after the read is not its clock.
const AHEAD_MS = 10 * 60_000;
const MAX_SHIPMENTS = 25;
const MAX_ADDRESSES = 10;
const MAX_REFERENCES = 50;
const MAX_ROWS = 500;
const MAX_EVENTS = 200;

/** A number BlueGrace's tracker looks up, as typed; anything else is not one. */
export function normalizeBluegraceNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'BlueGrace tracks its bills of lading and carriers’ PRO numbers: five to thirty letters and digits');
  }
  return number;
}

function invalid(message = 'BlueGrace returned an unexpected tracking reply'): never {
  throw new SchemaError(PROVIDER, message);
}

/** A Cloudflare check in place of a page or a reply. */
export function assertNotChallenged(body: string): void {
  if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'BlueGrace answered with a browser check');
}

/** The nonce the tracking page gives its lookup, in `bluegraceTracking`; exactly one. */
export function parseBluegraceNonce(html: string): string {
  const settings = [...html.matchAll(SETTINGS)];
  if (settings.length !== 1) {
    assertNotChallenged(html);
    invalid('BlueGrace’s tracking page no longer gives its lookup’s nonce');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(settings[0]![1]!);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'BlueGrace’s tracking page gives unreadable lookup settings', { cause });
  }
  const nonce = isRecord(parsed) && typeof parsed.nonce === 'string' ? parsed.nonce : '';
  if (!NONCE.test(nonce)) invalid('BlueGrace’s tracking page gives an invalid nonce');
  return nonce;
}

/** An optional record: absent is empty, anything but an object is a changed reply. */
function record(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = row[key];
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) invalid(`BlueGrace returned an invalid ${key}`);
  return value;
}

/** An optional list: absent is empty, anything but an array is a changed reply. */
function list(row: Record<string, unknown>, key: string, max: number): unknown[] {
  const value = row[key];
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) invalid(`BlueGrace returned an invalid ${key}`);
  if (value.length > max) invalid(`BlueGrace returned an oversized ${key}`);
  return value as unknown[];
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`BlueGrace returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A reference as the tracker compares it: whole, in capitals, without separators. */
function referenceKey(value: string): string {
  return value.length <= 64 ? normalizeTrackingNumber(value) : '';
}

/** The shipment's PRO numbers: the tracking record's and the PRO references. */
function prosOf(shipment: Record<string, unknown>): string[] {
  const pros = [text(record(shipment, 'trackingInfo'), 'pro', 64)];
  for (const reference of list(shipment, 'references', MAX_REFERENCES)) {
    if (!isRecord(reference)) invalid('BlueGrace returned an invalid reference');
    if (text(reference, 'name', 40).toUpperCase() === 'PRO') pros.push(text(reference, 'value', 64));
  }
  return [...new Set(pros.map(referenceKey).filter(Boolean))];
}

/** Whether a shipment of the reply is the one asked for: its bill of lading, or one of its PRO numbers. */
function names(shipment: Record<string, unknown>, number: string, reference: BluegraceReference): boolean {
  return reference === 'BOL' ? referenceKey(text(shipment, 'bol', 64)) === number : prosOf(shipment).includes(number);
}

/**
 * The reply's shipment for the number asked. An empty list is the tracker's
 * answer for a number it has no shipment under. A shipment must name the
 * whole number; several shipments sharing a PRO number, as carriers' numbers
 * can, settle nothing.
 */
export function bluegraceShipment(payload: unknown, raw: string, reference: BluegraceReference): Record<string, unknown> {
  const number = normalizeBluegraceNumber(raw);
  if (!Array.isArray(payload)) invalid();
  if (payload.length === 0) throw new NotFoundError(PROVIDER, 'BlueGrace has no shipment under this number');
  if (payload.length > MAX_SHIPMENTS) invalid('BlueGrace returned an oversized tracking reply');
  const shipments = (payload as unknown[]).map((entry) => (isRecord(entry) ? entry : invalid('BlueGrace returned an invalid shipment')));
  const matches = shipments.filter((shipment) => names(shipment, number, reference));
  if (!matches.length) throw new IndeterminateError(PROVIDER, 'BlueGrace answered for another shipment');
  if (new Set(matches.map((shipment) => referenceKey(text(shipment, 'bol', 64)))).size > 1) {
    throw new IndeterminateError(PROVIDER, 'BlueGrace holds several shipments under this PRO number', { reason: 'several_parcels' });
  }
  const shipment = matches[0]!;
  if (text(shipment, 'businessUnit', 120).toLowerCase() === TEST_UNIT) {
    throw new IndeterminateError(PROVIDER, 'BlueGrace answered with its integration test record');
  }
  return shipment;
}

/** A row's clock: its wall time to the second. */
function wallClock(value: string): string {
  const match = CLOCK.exec(value);
  if (!match) invalid('BlueGrace returned an invalid tracking date');
  const [, year, month, date, hour, minute, second] = match;
  const day = calendarDay(Number(year), Number(month), Number(date));
  // Luxon accepts hour 24, so the clock's fields are checked here.
  if (!day || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) invalid('BlueGrace returned an invalid tracking date');
  return `${day}T${hour}:${minute}:${second}`;
}

/** A town as the page writes it: the carriers' capitals capitalized word by word, other spellings kept. */
function townOf(value: string): string {
  if (value !== value.toUpperCase()) return value;
  return value.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_all, before: string, letter: string) => before + letter.toUpperCase());
}

interface Place {
  readonly location: string;
  readonly state: string;
  /** The zone of a state that keeps one clock throughout, on a shipment within the United States. */
  readonly zone: string | null;
}

/** A row's town and state, and the state's zone where it settles one. */
function placeOf(row: Record<string, unknown>, domestic: boolean): Place {
  const town = townOf(text(row, 'city', 80));
  const state = text(row, 'state', 8).toUpperCase();
  const location = [town, state].filter(Boolean).join(', ');
  const zone = domestic && state && !otherRegionZones('US', state).length ? usStateTimeZone(state) : null;
  return { location, state, zone };
}

/**
 * A row dated on its state's clock. The rows give no zone; a carrier's scan
 * is written on the clock of the terminal or dock it happened at, which a
 * state that keeps one zone settles. A zone that would date the row after
 * the read is not its clock, so the row keeps its wall clock alone.
 */
function dated(local: string, zone: string | null, readAt: number): Pick<CarrierEvent, 'time' | 'time_zone' | 'time_zone_basis'> {
  const time = zone ? isoTime(local, zone) : null;
  if (!zone || !time || time.timestamp > readAt + AHEAD_MS) return {};
  return { time: time.iso, time_zone: zone, time_zone_basis: 'place' };
}

interface Row {
  readonly index: number;
  readonly code: string;
  readonly local: string;
  readonly event: CarrierEvent;
}

/**
 * One row of `trackingInfo.details`: its X12 214 status code and wording,
 * clock, town and state, and for a delay its late reason. The comments are
 * not read.
 */
function readRow(row: unknown, index: number, consigneeState: string, domestic: boolean, readAt: number): Row {
  if (!isRecord(row)) invalid('BlueGrace returned an invalid tracking row');
  const code = text(row, 'trackStatusCode', 8).toUpperCase();
  const wording = text(row, 'trackStatus', 160);
  if (!CODE.test(code) || !wording) invalid('BlueGrace returned a tracking row without its status');
  const local = wallClock(text(row, 'trackingDate', 40));
  const { location, state, zone } = placeOf(row, domestic);
  const reason = text(row, 'lateReason', 120);
  const description = code === DELAYED && reason && text(row, 'lateReasonCode', 8).toUpperCase() !== NORMAL_STATUS
    ? `${wording}: ${reason}` : wording;
  const staged = code === EN_ROUTE
    ? { stage: (state && state === consigneeState ? 'out_for_delivery' : 'in_transit') as Stage, source: 'carrier_map' }
    : bluegraceStage(code, wording);
  return { index, code, local, event: {
    local_time: local, ...dated(local, zone, readAt), ...(location ? { location } : {}), description, provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

// How far along a shipment a stage is, to order rows of one clock.
const PROGRESS: Readonly<Partial<Record<string, number>>> = { registered: 1, accepted: 2, out_for_delivery: 4, delivered: 5 };

function progress(row: Row): number {
  return PROGRESS[row.event.stage ?? ''] ?? 3;
}

/** The carrier BlueGrace booked, by catalog id, and its PRO number, where the catalog tracks that carrier. */
function handoffOf(shipment: Record<string, unknown>): { delivery_carrier: string; delivery_tracking_number: string } | null {
  const scac = text(record(shipment, 'carrier'), 'scac', 8).toUpperCase();
  const carrier = Object.hasOwn(CARRIERS, scac) ? CARRIERS[scac]! : null;
  const bol = referenceKey(text(shipment, 'bol', 64));
  const pros = prosOf(shipment).filter((pro) => PRO.test(pro) && pro !== bol);
  // Two PRO numbers name no one shipment of the carrier.
  return carrier && pros.length === 1 ? { delivery_carrier: carrier, delivery_tracking_number: pros[0]! } : null;
}

/** The delivery estimate's day: the tracking record's, else the newest estimate or appointment row's. */
function estimateOf(info: Record<string, unknown>, forecasts: readonly Row[]): string | null {
  const stated = text(info, 'estimatedDeliveryDate', 40);
  if (stated) return wallClock(stated).slice(0, 10);
  const newest = forecasts.at(-1);
  return newest ? newest.local.slice(0, 10) : null;
}

/**
 * The shipment the tracker found, as `GET /wp-admin/admin-ajax.php?action=bluegrace_shipment_search`
 * answers for the reference asked: a list of shipments, each with its bill of
 * lading (`bol`), parties (`addresses`), booked carrier (`carrier`), PRO
 * references and tracking record (`trackingInfo`), whose `details` are the
 * carrier's X12 214 status rows in the order BlueGrace recorded them. The
 * parties' names, streets, contacts, emails and phones, the customer's
 * business unit, the goods and the billing are not kept; the parties'
 * countries and the consignee's state are read for the rows' clocks and stages.
 */
export function parseBluegrace(payload: unknown, raw: string, reference: BluegraceReference, readAt = Date.now()): CarrierResult {
  const shipment = bluegraceShipment(payload, raw, reference);
  const addresses = list(shipment, 'addresses', MAX_ADDRESSES)
    .map((address) => (isRecord(address) ? address : invalid('BlueGrace returned an invalid address')));
  // The page reads the shipper first and the consignee second.
  const consigneeState = addresses.length >= 2 ? text(addresses[1]!, 'stateProvince', 8).toUpperCase() : '';
  const domestic = addresses.length >= 2 && addresses.every((address) => countryCode(text(address, 'country', 40)) === 'US');
  const info = record(shipment, 'trackingInfo');
  const rows = list(info, 'details', MAX_ROWS).map((row, index) => readRow(row, index, consigneeState, domestic, readAt));
  const estimate = estimateOf(info, rows.filter((row) => FORECASTS.has(row.code)));
  const handoff = handoffOf(shipment);
  // Newest first by wall clock. Carriers send rows of one minute in either
  // order, as an unloading before the arrival: of those the furthest along
  // comes first, then the one BlueGrace recorded last.
  const scans = rows.filter((row) => !FORECASTS.has(row.code)).sort((a, b) => (a.local === b.local
    ? progress(b) - progress(a) || b.index - a.index : a.local < b.local ? 1 : -1));
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const { event } of scans) {
    const key = JSON.stringify([event.local_time, event.provider_code, event.description, event.location ?? '']);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  if (!events.length) {
    throw new NoHistoryError(PROVIDER, 'BlueGrace lists the shipment without tracking rows', { reason: 'listed',
      ...(handoff ? { deliveryCarrier: handoff.delivery_carrier, deliveryTrackingNumber: handoff.delivery_tracking_number } : {}) });
  }

  // A delivery ends the shipment, and a row recorded after it moves nothing; otherwise the newest staged row decides.
  const newest = events[0]!;
  const delivery = events.find((event) => event.stage === 'delivered');
  const staged = delivery ?? events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const settled = stage === 'delivered' || stage === 'returned';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(staged && stage ? { current_stage: stage, current_stage_source: staged.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: settled ? null : estimate,
    ...(handoff ?? {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
