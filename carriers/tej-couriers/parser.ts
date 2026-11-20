import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { tejStage, tejSummaryStage } from './status.js';

export const PROVIDER = 'Tej Couriers';
// A long history is a few kilobytes.
export const TEJ_MAX_BYTES = 256 * 1024;
// Eight digits, as on every consignment note customers quote.
const NUMBER = /^\d{8}$/;
// The service's answer for a number it does not know, which the page shows as an invalid consignment number.
const UNKNOWN_NUMBER = 'check login credentials';
// A day first, by number or by month name, or a year first; then a time, with or without seconds and a meridiem, if any.
const CLOCK = /^(?:(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})[-/. ](\d{1,2}|[A-Z]{3})[-/. ](\d{4}))(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,7})?)?\s*([AP]M)?)?$/;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
// A delivery's own wording; what follows it says who took the consignment.
const DELIVERY_DONE = /(\bDELIVERY\s*DONE\b)[\s\S]*$/i;
// A verb whose object is a person: the verb stays, the person goes.
const HANDED = /\b(delivered|received|signed|handed(?:\s+over)?|collected|picked\s+up|accepted|booked)\s+(?:to|by)\b[\s\S]*$/i;
// A labelled detail about a person, such as "Receiver: …" or "Mob No: …", to the end of the wording.
const LABELLED = /\s*[,;(|]?\s*\b(?:receiver|recipient|consignee|consignor|sender|signed?|signature|stamp|relation|delivery\s+boy|del\.?\s+boy|boy|emp(?:loyee)?|mob(?:ile)?|ph(?:one)?|contact|name|remarks?)(?:\s+(?:name|no\.?|number|details?))?\s*[:=][\s\S]*$/i;
// Whom a run sheet is made out to.
const BY = /\s+by\b[\s\S]*$/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){8,}(?!\d)/g;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Tej Couriers consignment number: eight digits. Anything else is not a number Tej Couriers issues. */
export function normalizeTejNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Tej Couriers consignment numbers are eight digits');
  return number;
}

/** A text field; anything but a string, or null, is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Tej Couriers returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's wall clock as `yyyy-MM-ddTHH:mm:ss`, or its day alone when it has
 * no time. The history names no zone, so the clock keeps none; UTC only checks
 * the calendar fields.
 */
export function tejClock(value: string): string {
  const match = CLOCK.exec(value.replace(/\s+/g, ' ').trim().toUpperCase());
  if (!match) throw new SchemaError(PROVIDER, 'Tej Couriers returned an invalid scan time');
  const [, isoYear, isoMonth, isoDay, day, month, year, hour, minute, second, meridiem] = match;
  const monthNumber = isoMonth ? Number(isoMonth) : /^\d+$/.test(month!) ? Number(month) : MONTHS.indexOf(month!) + 1;
  let hours = Number(hour ?? 0);
  if (meridiem) hours = hours >= 1 && hours <= 12 ? (hours % 12) + (meridiem === 'PM' ? 12 : 0) : -1;
  const wall = DateTime.fromObject({ year: Number(isoYear ?? year), month: monthNumber, day: Number(isoDay ?? day),
    hour: hours, minute: Number(minute ?? 0), second: Number(second ?? 0) }, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only an hour of the day is kept.
  if (!wall.isValid || hours > 23 || wall.year < 2000) throw new SchemaError(PROVIDER, 'Tej Couriers returned an invalid scan time');
  return wall.toFormat(hour === undefined ? 'yyyy-MM-dd' : "yyyy-MM-dd'T'HH:mm:ss");
}

/**
 * A scan's wording without phone numbers or the details that name a person. A
 * delivery keeps its wording alone, and a run sheet loses whom it is made out to.
 */
export function tejWording(activity: string, stage?: string): string {
  let own = activity.replace(PHONE, '');
  if (stage === 'delivered' || stage === 'returned') own = own.replace(DELIVERY_DONE, '$1');
  if (stage === 'out_for_delivery') own = own.replace(BY, '');
  own = own.replace(LABELLED, '').replace(HANDED, '$1');
  return clean(own, 200).replace(/^[\s,;:.\-–|]+|[\s,;:\-–|(]+$/g, '');
}

/** The expected delivery day, when the reply gives one as a calendar date. */
function deliveryDay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const day = /^(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?)?$/.exec(value.trim())?.[1];
  return day && DateTime.fromISO(day, { zone: 'UTC' }).isValid && day > '2000-01-01' ? day : null;
}

/** The consignment number a shipment names, as text; a number must be an exact, nonnegative integer. */
function cnote(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && value.length <= 64) return normalizeTrackingNumber(value.trim());
  throw new SchemaError(PROVIDER, 'Tej Couriers returned a consignment without its number');
}

interface Scan { event: CarrierEvent; at: string; index: number }

function projectRow(row: unknown, index: number): (Scan & { key: string }) | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Tej Couriers returned an invalid scan');
  if (typeof row.Activety !== 'string') throw new SchemaError(PROVIDER, 'Tej Couriers returned a scan without wording');
  const activity = text(row, 'Activety');
  if (typeof row.dateAndTime !== 'string') throw new SchemaError(PROVIDER, 'Tej Couriers returned an invalid scan time');
  const local = tejClock(row.dateAndTime.slice(0, 64));
  const staged = tejStage(activity);
  const description = tejWording(activity, staged?.stage);
  const location = text(row, 'transitLocation', 120);
  // The native history can end with a dated, empty activity. It is not a new scan.
  if (!activity) return null;
  if (!description) throw new SchemaError(PROVIDER, 'Tej Couriers returned a scan without wording');
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at: local, index, key: JSON.stringify([local, description, location]) };
}

/** The tracking list inside the reply's `PayLoad`, a JSON document in a string. */
function trackingList(row: Record<string, unknown>): unknown[] {
  if (typeof row.PayLoad !== 'string') throw new SchemaError(PROVIDER, 'Tej Couriers returned a reply without a payload');
  let document: unknown;
  try {
    document = JSON.parse(row.PayLoad);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'Tej Couriers returned a payload that is not JSON', { cause });
  }
  const list = isRecord(document) && isRecord(document.payload) ? document.payload.individualTrackingList : undefined;
  if (!Array.isArray(list)) throw new SchemaError(PROVIDER, 'Tej Couriers returned a payload without its tracking list');
  return list;
}

/**
 * The reply of the tracking page's `api/tracking/php/tracking.php` for one
 * consignment number. A found consignment is a list whose first row carries a
 * `PayLoad` string; its `individualTrackingList` names the consignment, with
 * its `transitHistory`. `{"notfound":true}` is explicit missing history. Credential-like refusals
 * do not establish a missing consignment. The
 * consignor, consignee, postcode, article count, weight and proof-of-delivery
 * link are not read.
 */
export function parseTej(payload: unknown, raw: string): CarrierResult {
  const number = normalizeTejNumber(raw);
  if (isRecord(payload)) {
    if (payload.notfound === true) throw new NotFoundError(PROVIDER);
    if (payload.error !== undefined && payload.error !== null && payload.error !== false) {
      throw new IndeterminateError(PROVIDER, 'Tej Couriers did not complete the lookup');
    }
    throw new SchemaError(PROVIDER, 'Tej Couriers returned an invalid envelope');
  }
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'Tej Couriers returned an invalid envelope');
  if (!payload.length) throw new NotFoundError(PROVIDER);
  if (payload.length !== 1) throw new IndeterminateError(PROVIDER, 'Tej Couriers returned several replies for one consignment');
  const row: unknown = payload[0];
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Tej Couriers returned an invalid envelope');
  if (row.PayLoad === undefined && typeof row.Status === 'string' && clean(row.Status, 100).toLowerCase() === UNKNOWN_NUMBER) {
    throw new IndeterminateError(PROVIDER, 'Tej Couriers refused the guest lookup');
  }
  if (row.PayLoad === undefined && typeof row.errorMessage === 'string' && row.errorMessage.trim()) {
    throw new IndeterminateError(PROVIDER, 'Tej Couriers did not complete the guest lookup');
  }
  const list = trackingList(row);
  if (!list.length) throw new NoHistoryError(PROVIDER);
  if (list.length !== 1) throw new IndeterminateError(PROVIDER, 'Tej Couriers returned several consignments for one number');
  const shipment = list[0];
  if (!isRecord(shipment)) throw new SchemaError(PROVIDER, 'Tej Couriers returned an invalid consignment');
  if (cnote(shipment.cnote) !== number) throw new IndeterminateError(PROVIDER, 'Tej Couriers answered for another consignment');
  const rows = shipment.transitHistory;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Tej Couriers returned a consignment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Tej Couriers returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((item, index) => {
    const scan = projectRow(item, index);
    if (!scan) return;
    if (seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first. The order the reply lists scans in breaks a tie between two on one clock.
  const oldestFirst = scans[0]!.at <= scans.at(-1)!.at;
  const events = scans.sort((a, b) => (a.at === b.at ? (oldestFirst ? b.index - a.index : a.index - b.index) : a.at < b.at ? 1 : -1))
    .map(({ event }) => event);

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  // A booking or a receipt among several scans is in transit, as the page's own summary counts it.
  const early = staged?.stage === 'registered' || staged?.stage === 'accepted';
  const current = staged && !(early && events.length > 1) ? staged : undefined;
  // Without a scan that names a later step, the page's summary: booked, then in transit.
  const stage = (current?.stage ?? tejSummaryStage(events.length)) as Stage;
  const expected = stage === 'delivered' || stage === 'returned' ? null : deliveryDay(shipment.DlvDate);
  return {
    status: languageStageStatus(stage),
    current_stage: stage,
    current_stage_source: current?.stage_source ?? 'carrier_map',
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: expected,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
