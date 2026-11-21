import { DateTime } from 'luxon';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { BOOKED_STAGE, statusStage, travelStage } from './status.js';

export const provider = 'shree-nandan';

/** The three parts of the tracker's answer, by the `purpose` each request names. */
export const PURPOSES = { travel: '1', booking: '2', delivery: '3' } as const;
export type Part = keyof typeof PURPOSES;
export type Replies = Record<Part, unknown>;

// The notice sent with HTTP 423 for a shipment past the tracker's 180 days.
const WITHHELD = /not able to show Tracking Information/i;
// An office's phone number, which the travel rows give in a part of their own.
const PHONE = /^\+?\d[\d -]{6,}$/;

type Row = Record<string, unknown>;
type Dated = CarrierEvent & { description: string };

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number'
  ? String(value).split(/\s+/).filter(Boolean).join(' ') : '';

/** The notice a reply carries, empty when it carries none. */
function notice(payload: unknown): string {
  const lines = isRow(payload) && isRow(payload.STATUS) ? payload.STATUS.NOTIFICATION : undefined;
  return Array.isArray(lines) ? lines.map(text).filter(Boolean).join(' ') : '';
}

/** A reply sent with HTTP 423: the tracker withholds a shipment older than its 180 days. */
export function parseWithheld(payload: unknown): never {
  if (WITHHELD.test(notice(payload))) {
    throw new IndeterminateError(provider, 'Shree Nandan Courier no longer shows the shipment', { reason: 'history_expired' });
  }
  throw new SchemaError(provider, 'Shree Nandan Courier refused the lookup without its notice', { status: 423 });
}

/** The part of a reply about the number; another number's answer is no answer. */
function view(payload: unknown, part: Part, number: string): Row {
  const found = isRow(payload) ? payload.view : undefined;
  if (!isRow(found)) throw new SchemaError(provider, `Shree Nandan Courier omitted the ${part} view`);
  if (text(found.con_no) !== number) {
    throw new IndeterminateError(provider, 'Shree Nandan Courier did not return the requested consignment');
  }
  return found;
}

/** A database clock, `2026-10-26 10:33:24`, as the wall clock it is in India. */
function wallClock(value: string): string | undefined {
  const time = DateTime.fromFormat(value.replace(/\.\d+$/, ''), 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' });
  return time.isValid ? time.toFormat("yyyy-MM-dd'T'HH:mm:ss") : undefined;
}

/** A delivery date, day first. */
function calendarDay(value: string): string | undefined {
  const day = DateTime.fromFormat(value, 'dd/MM/yyyy', { zone: 'UTC' });
  return day.isValid ? day.toISODate() ?? undefined : undefined;
}

/** A delivery run sheet's clock, `26/10/2026 11:34:17 AM`. */
function runSheetClock(value: string): string | undefined {
  const time = DateTime.fromFormat(value.toUpperCase(), 'dd/MM/yyyy hh:mm:ss a', { zone: 'UTC', locale: 'en-US' });
  return time.isValid ? time.toFormat("yyyy-MM-dd'T'HH:mm:ss") : undefined;
}

function clockOf(local: string | undefined, raw: string): Pick<CarrierEvent, 'local_time'> | { provider_time_text: string } {
  return local ? { local_time: local } : { provider_time_text: raw };
}

function travelEvent(row: unknown, number: string): Dated | undefined {
  if (!isRow(row)) throw new SchemaError(provider, 'Shree Nandan Courier returned a malformed travel row');
  // A row about another item, such as the bag the parcel travels in, is not the parcel's.
  const item = text(row.item_no);
  if (item && item !== number) return undefined;
  // The page shows the parts of a row's text one after the other, the office's phone apart.
  const description = [row.result1, row.result2, row.result3, row.result4].map(text)
    .filter((part) => part && !PHONE.test(part)).join(' ') || text(row.ta_name);
  if (!description) return undefined;
  const created = text(row.created);
  const action = text(row.ta_id);
  const stage = travelStage(action);
  const location = text(row.org_name);
  return {
    ...clockOf(wallClock(created), created), ...(location ? { location } : {}), description,
    ...(action ? { provider_code: action } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  };
}

function deliveryEvent(row: unknown): Dated | undefined {
  if (!isRow(row)) throw new SchemaError(provider, 'Shree Nandan Courier returned a malformed delivery record');
  const status = text(row.delivery_status);
  if (!status) return undefined;
  const reason = text(row.reason);
  // The delivery date has no time of day; a record without one is dated by its run sheet.
  const dated = text(row.delivery_date);
  const local = dated ? calendarDay(dated) : runSheetClock(text(row.drs_date));
  const stage = statusStage(status);
  const location = text(row.center);
  return {
    ...clockOf(local, dated || text(row.drs_date)), ...(location ? { location } : {}),
    description: reason && reason.toLowerCase() !== status.toLowerCase() ? `${status}: ${reason}` : status,
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  };
}

function bookingEvent(booking: Row): Dated | undefined {
  const booked = wallClock(text(booking.bk_date));
  if (!booked) return undefined;
  const location = text(booking.center);
  return { local_time: booked, ...(location ? { location } : {}), description: 'Booked', stage: BOOKED_STAGE, stage_source: 'carrier_map' };
}

// A date-only delivery comes after the scans of its day; an undated row last.
const sortKey = (event: CarrierEvent): string => !event.local_time ? ''
  : event.local_time.length === 10 ? `${event.local_time}T24` : event.local_time;

export function parseTracking(replies: Replies, number: string): CarrierResult {
  const travel = view(replies.travel, 'travel', number).traveling_info;
  const booking = view(replies.booking, 'booking', number).booking;
  const deliveries = view(replies.delivery, 'delivery', number).delivery_details;
  if (!Array.isArray(travel) || (booking !== null && !isRow(booking)) || (deliveries !== null && !Array.isArray(deliveries))) {
    throw new SchemaError(provider, 'Shree Nandan Courier returned an unexpected tracking view');
  }
  // The tracker's "No Record Found": no travel row, booking or delivery record.
  if (travel.length === 0 && booking === null && !deliveries?.length) throw new NotFoundError(provider);
  if (booking && text(booking.con_no) !== number) {
    throw new IndeterminateError(provider, 'Shree Nandan Courier returned another consignment\'s booking');
  }

  // Travel rows come newest first and delivery records oldest first: built newest first, the
  // stable sort keeps rows of the same clock in the carrier's order.
  const rows = [
    ...travel.map((row) => travelEvent(row, number)),
    ...(deliveries ?? []).map(deliveryEvent).reverse(),
    booking ? bookingEvent(booking) : undefined,
  ].filter((event): event is Dated => event !== undefined);
  const events = rows.sort((left, right) => {
    const [later, earlier] = [sortKey(right), sortKey(left)];
    return later > earlier ? 1 : later < earlier ? -1 : 0;
  });
  if (events.length === 0) {
    throw new IndeterminateError(provider, 'Shree Nandan Courier lists the number without a dated step');
  }

  // The tracker shows the booking's status as the parcel's; scans written after a delivery keep it.
  const summary = booking ? text(booking.bk_status) : '';
  const summaryStage = summary ? statusStage(summary) : undefined;
  const staged = events.find((event) => event.stage);
  const stage = summaryStage ?? staged?.stage as Stage | undefined;
  const service = booking ? text(booking.product) : '';
  const receiver = booking ? text(booking.r_name) : '';
  const destination = booking ? text(booking.r_city) : '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: summaryStage ? summary : events[0]!.description,
    last_update_local: events.find((event) => event.local_time)?.local_time ?? null,
    ...(service ? { service_name: service } : {}),
    ...(receiver ? { receiver_name: receiver } : {}),
    ...(destination ? { receiver_address: destination } : {}),
    events,
  };
}
