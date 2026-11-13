import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { isPeninsulaHandoff, peninsulaStage } from './status.js';

export const PROVIDER = 'Peninsula Truck Lines';
// A shipment's reply is a few kilobytes.
export const PENINSULA_MAX_BYTES = 256 * 1024;

// A PRO is a run of digits. The tracker checks no layout; the tracking API guide's examples run
// from eight to twelve digits, and so does the adapter.
const NUMBER = /^\d{8,12}$/;
// The answer for a PRO the guest lookup does not have.
const UNKNOWN_STATUS = 30001;
const UNKNOWN_MESSAGE = /\bcould not be located\b/i;
// "2023-02-06": every date the reply gives. The page reads it with a date library, which would
// read the same day written as its midnight too.
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]00:00:00(?:\.0+)?Z?)?$/;
// "10:14am": a 12-hour time with its half of the day straight after it.
const TIME = /^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i;
// The delivery day a delivered line ends with: "DELIVERED ON 2023-02-17".
const DELIVERED = /^DELIVERED\b/i;
const DELIVERY_DAY = /\bON\s+(\d{4})-(\d{2})-(\d{2})\b/i;
// A signer or receiver named after a scan's wording.
const SIGNER = /\s*[-:,]?\s*\b(?:SIGNED(?:\s+FOR)?(?:\s+BY)?|SIGNATURE|SIGNER|RECEIVED\s+BY|ACCEPTED\s+BY|REC'?D\s+BY)\b.*$/i;
// A stage the shipment's status settles over the newest row.
const SETTLED = new Set<Stage>(['delivered', 'returned', 'exception']);
const MAX_ROWS = 500;

/** A Peninsula PRO, as typed; anything else is not one its guest lookup is asked for. */
export function normalizePeninsulaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Peninsula Truck Lines PROs are eight to twelve digits');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`Peninsula returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** The shipment's PRO: a string, or a whole number written as one. */
function proOf(payload: Record<string, unknown>): string {
  const value = payload.proNumber;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return text(payload, 'proNumber', 40);
}

/** "2023-02-06" as a checked calendar day. */
function dayOf(value: string): string | null {
  const match = DATE.exec(value);
  return match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

/** A row's date and 12-hour time as a wall clock; a row without a time keeps its day. No clock names its zone. */
function wallClock(row: Record<string, unknown>): string {
  const day = dayOf(text(row, 'date', 40));
  if (!day) invalid('Peninsula returned a log row without its date');
  const time = text(row, 'time', 20);
  if (!time) return day;
  const match = TIME.exec(time);
  const hour = Number(match?.[1]);
  if (!match || hour < 1 || hour > 12 || Number(match[2]) > 59) invalid('Peninsula returned a log row with an invalid time');
  const hours = (hour % 12) + (match[3]!.toLowerCase() === 'p' ? 12 : 0);
  return `${day}T${String(hours).padStart(2, '0')}:${match[2]}:00`;
}

/**
 * Wording without the person who received the freight: a delivered line keeps
 * its delivery day and nothing else ("DELIVERED TO <name> ON 2023-02-17" reads
 * "DELIVERED ON 2023-02-17"), and a signer named after other wording is cut off.
 */
export function withoutSigner(wording: string): string {
  if (DELIVERED.test(wording)) {
    const day = DELIVERY_DAY.exec(wording);
    const date = day ? calendarDay(Number(day[1]), Number(day[2]), Number(day[3])) : null;
    return date ? `DELIVERED ON ${date}` : 'DELIVERED';
  }
  return wording.replace(SIGNER, '').trim();
}

/** A row's place, a town and state as "PORTLAND, OR"; a part holding a digit could be a street or a postcode and is left out. */
function placeOf(value: string): string {
  return value.split(' ').filter((part) => part && !/\d/.test(part)).join(' ').replace(/^[,\s]+|[,\s]+$/g, '');
}

function staged(event: CarrierEvent, wording: string): CarrierEvent {
  const stage = peninsulaStage(wording);
  return stage ? { ...event, stage: stage.stage, stage_source: stage.source } : event;
}

/** One row of the shipment log: its `date`, `time`, `activity` and `location`. */
function projectRow(row: unknown): CarrierEvent {
  if (!isRecord(row)) invalid('Peninsula returned an invalid log row');
  const local_time = wallClock(row);
  const description = withoutSigner(text(row, 'activity', 200));
  if (!description) invalid('Peninsula returned a log row without its activity');
  const location = placeOf(text(row, 'location', 120));
  return staged({ local_time, ...(location ? { location } : {}), description }, description);
}

/** The shipment log, newest first and once each. */
function history(rows: unknown[]): CarrierEvent[] {
  if (rows.length > MAX_ROWS) invalid('Peninsula returned an oversized shipment log');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const event of rows.map(projectRow)) {
    const key = JSON.stringify([event.local_time, event.description, event.location ?? '']);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  // The guide's example lists the oldest row first; a list that way round is turned round. A row with its day
  // and no time orders only against another day, so the first rows that compare decide.
  const direction = order(events[0], events.at(-1)) || events.slice(1).map((event, index) => order(events[index], event)).find(Boolean);
  return (direction ?? 0) < 0 ? events.reverse() : events;
}

/** How two rows' clocks compare: by day, and within a day only when both have a time. */
function order(left: CarrierEvent | undefined, right: CarrierEvent | undefined): number {
  const [from, to] = [left?.local_time ?? '', right?.local_time ?? ''];
  if (!from || !to) return 0;
  return from.slice(0, 10) !== to.slice(0, 10) || (from.length > 10 && to.length > 10) ? from.localeCompare(to) : 0;
}

/** The delivery the status line dates, placed among the rows by its day, when no row records one. */
function withDelivery(events: CarrierEvent[], status: string): CarrierEvent[] {
  const day = DELIVERY_DAY.exec(status);
  if (!day || events.some((event) => event.stage === 'delivered')) return events;
  const local_time = `${day[1]}-${day[2]}-${day[3]}`;
  const delivery = staged({ local_time, description: status }, status);
  const at = events.findIndex((event) => event.local_time!.slice(0, 10) <= local_time);
  return at < 0 ? [...events, delivery] : [...events.slice(0, at), delivery, ...events.slice(at)];
}

/**
 * The reply of `api/track/public/{PRO}`, the guest lookup the tracking page at
 * `www.peninsulatruck.com/track/?pro_number={PRO}` makes: the shipment's PRO,
 * its status line (`proStatus`) and its log (`shipmentLog`), with an
 * `ok` status. A PRO the lookup does not have is status 30001, "The search
 * value could not be located". A reference that matches several shipments
 * lists them in `shipments` and leaves the PRO empty. The reply can also name
 * the shipper and the consignee with their addresses, the bill of lading, the
 * purchase order, an interline partner's PRO and the terminals; none of them
 * is read.
 */
export function parsePeninsula(payload: unknown, raw: string): CarrierResult {
  const number = normalizePeninsulaNumber(raw);
  if (!isRecord(payload)) invalid('Peninsula returned an invalid reply');
  const outcome = text(payload, 'status', 80);
  if (outcome !== 'ok') {
    if (payload.statusNbr === UNKNOWN_STATUS && UNKNOWN_MESSAGE.test(text(payload, 'statusMsg', 500))) throw new NotFoundError(PROVIDER);
    if (/^error\b/i.test(outcome)) throw new IndeterminateError(PROVIDER, 'Peninsula answered with an error it does not usually give');
    invalid('Peninsula returned a reply without its status');
  }
  const shipments = payload.shipments ?? [];
  if (!Array.isArray(shipments)) invalid('Peninsula returned invalid shipments');
  // A cross-reference that matched several shipments names none of them as the PRO asked.
  if (shipments.length) throw new IndeterminateError(PROVIDER, 'Peninsula matched several shipments');
  const pro = proOf(payload);
  if (pro !== number) throw new IndeterminateError(PROVIDER, 'Peninsula answered for another shipment');
  if (!Array.isArray(payload.shipmentLog)) invalid('Peninsula returned a shipment without its log');
  const rows: unknown[] = payload.shipmentLog;

  const status = withoutSigner(text(payload, 'proStatus', 300));
  const headline: ClassifiedWording | null = status ? peninsulaStage(status) : null;
  const events = headline?.stage === 'delivered' ? withDelivery(history(rows), status) : history(rows);
  if (!events.length && !status) throw new NoHistoryError(PROVIDER);

  // The status line settles a delivery, a return, a problem and the hand-off to a partner
  // carrier, and a shipment without a staged row; otherwise the newest staged row is ahead of it.
  const scanned = events.find((event) => event.stage);
  const settled = headline !== null && (SETTLED.has(headline.stage) || isPeninsulaHandoff(status) || !scanned);
  const decided: ClassifiedWording | null = settled ? headline
    : scanned ? { stage: scanned.stage as Stage, source: scanned.stage_source! } : null;
  const newest = events[0];
  return {
    status: decided ? languageStageStatus(decided.stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: (settled ? status : newest?.description) || status || null,
    last_update: null,
    ...(newest?.local_time ? { last_update_local: newest.local_time } : {}),
    ...(rows.length ? {} : { summary_only: true }),
    events,
  };
}
