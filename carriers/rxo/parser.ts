import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { windowEstimate } from '../../core/result/window.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { statusMap } from './status.js';

export const PROVIDER = 'rxo';
/** The lookup RXO's tracking page asks for a tracking number: `<number>?billTo=0`. */
export const RXO_LOOKUP = 'https://clm.rxo.com/trackapi/orders/trackbillto/';
// An order's reply is 10 to 25 KB per appointment.
export const RXO_MAX_BYTES = 1024 * 1024;

// Letters and digits with at least one digit: RXO's own tracking number or its sales order id.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
// A firewall's, CDN's or bot check's page in place of the tracker's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha|incapsula|_Incapsula_Resource/i;
// "2026-10-16T06:45:26": the event's wall clock, without a zone.
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,7})?)?$/;
// "10/15/2026 18:45:00 -04:00": an end of the appointment window, with its offset. Some retailers'
// appointments give it as "2026-10-15 08:00", on the wall clock.
const WINDOW_WALL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const WINDOW_END = /^(\d{2})\/(\d{2})\/(\d{4}) ([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))? ([+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
// The work order categories the tracking page's script names: a delivery, a return pickup, a service visit.
const DELIVERY = 1, RETURN = 2, SERVICE = 4;
// The stop exceptions the tracking page shows a closed work order as an exception for.
const STOP_NOT_PERFORMED = 'CANT-PERFORM-STOP';
const ITEM_NOT_HANDLED = 'CANT-PU/DEL-ITEM';
const FINAL: ReadonlySet<Stage> = new Set(['delivered', 'returned']);
const MAX_EVENTS = 300;
const MAX_ORDERS = 50;

/** A number for RXO's tracker: letters and digits, in capitals. */
export function normalizeRxoNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'RXO tracks numbers of 8 to 30 letters and digits');
  return number;
}

/** Whether a reply is a block page instead of the tracker's JSON. */
export function isRxoBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A text field, or nothing; anything but a string or null is a changed reply. */
function text(value: unknown, max: number, what: string): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? clean(value, max) : invalid(`RXO returned an invalid ${what}`);
}

/** An event's clock: the wall clock RXO gives without a zone stays one; an instant keeps its offset. */
function clockOf(value: unknown): Pick<CarrierEvent, 'time' | 'local_time'> {
  const raw = typeof value === 'string' ? value.trim() : '';
  const wall = WALL_CLOCK.exec(raw);
  if (wall) {
    const day = calendarDay(Number(wall[1]), Number(wall[2]), Number(wall[3]));
    if (!day || Number(wall[1]) < 2000) return invalid('RXO returned an invalid event time');
    return { local_time: `${day}T${wall[4]}:${wall[5]}:${wall[6] ?? '00'}` };
  }
  const instant = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? explicitOffsetTime(raw) : null;
  return instant ? { time: instant.iso } : invalid('RXO returned an event without its time');
}

interface WorkOrder {
  readonly category: number | null;
  readonly status: string;
  readonly events: CarrierEvent[];
  /** The newest event's wall clock or instant, to order the appointments. */
  readonly newest: string;
  readonly booked: string;
  readonly order: Record<string, unknown>;
}

/** One event: its wording, its clock and the town. */
function eventOf(row: unknown): CarrierEvent {
  if (!isRecord(row)) return invalid('RXO returned an invalid event');
  const description = text(row.name, 200, 'event') || invalid('RXO returned an event without its wording');
  const location = text(row.city, 120, 'event place');
  const staged = statusMap.stage(null, description);
  return {
    ...clockOf(row.eventDate),
    description,
    ...(location ? { location } : {}),
    ...(staged ? { stage: staged, stage_source: 'carrier_map' } : {}),
  };
}

function codeOf(exception: unknown): string {
  return isRecord(exception) && typeof exception.exceptionCode === 'string' ? exception.exceptionCode.trim().toUpperCase() : '';
}

/**
 * The exception the tracking page shows a closed delivery, return or service stop as, when it was not
 * performed: the stop's own "Cannot Perform Stop", or every item's "Cannot Pickup/Deliver Item".
 */
function notPerformed(order: Record<string, unknown>, category: number | null, status: string): Record<string, unknown> | undefined {
  if (status !== 'DL' || (category !== DELIVERY && category !== RETURN && category !== SERVICE)) return undefined;
  const exceptions: unknown[] = Array.isArray(order.exceptions) ? order.exceptions : [];
  const stop = exceptions.find((row) => isRecord(row) && row.exceptionTypeId === 1 && codeOf(row) === STOP_NOT_PERFORMED);
  if (isRecord(stop)) return stop;
  const items: unknown[] = Array.isArray(order.items) ? order.items : [];
  const itemException = (item: unknown): unknown => isRecord(item) && Array.isArray(item.exceptions)
    ? (item.exceptions as unknown[]).find((row) => isRecord(row) && row.exceptionTypeId === 2 && codeOf(row) === ITEM_NOT_HANDLED) : undefined;
  if (items.length === 0 || !items.every((item) => itemException(item))) return undefined;
  const first = itemException(items[0]);
  return isRecord(first) ? first : undefined;
}

/**
 * The stop's closing event, "Delivery completed" and the like, read as the exception the tracking
 * page shows for it. The wording the event came with stays as its original description. A service
 * visit's exception moves no parcel, so it keeps neither the code nor a stage.
 */
function asException(event: CarrierEvent, exception: Record<string, unknown>, service: boolean): CarrierEvent {
  const code = codeOf(exception);
  const description = text(exception.exceptionDetails, 200, 'exception') || text(exception.exceptionName, 120, 'exception') || event.description!;
  const stage = service ? undefined : statusMap.stage(code, description);
  return {
    ...(event.local_time ? { local_time: event.local_time } : { time: event.time! }),
    description, original_description: event.description!,
    ...(event.location ? { location: event.location } : {}),
    ...(service ? {} : { provider_code: code }),
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  };
}

function workOrderOf(order: Record<string, unknown>): WorkOrder {
  const category = typeof order.salesOrderCategoryId === 'number' && Number.isSafeInteger(order.salesOrderCategoryId) ? order.salesOrderCategoryId : null;
  const status = text(order.currentStatus ?? order.status, 20, 'status').toUpperCase();
  if (order.events !== null && order.events !== undefined && !Array.isArray(order.events)) return invalid('RXO returned invalid events');
  const rows = (order.events ?? []) as unknown[];
  if (rows.length > MAX_EVENTS) return invalid('RXO returned too many events');
  let events = rows.map(eventOf);
  // A service visit's own "Order Created" would read as a new order after the delivery.
  if (category === SERVICE) events = events.filter((event) => event.stage !== 'registered');
  const clock = (event: CarrierEvent) => event.local_time ?? event.time ?? '';
  events.sort((a, b) => clock(b).localeCompare(clock(a)));
  const exception = notPerformed(order, category, status);
  const closing = events[0];
  if (exception && closing && /\bcompleted$/i.test(closing.description ?? '')) events[0] = asException(closing, exception, category === SERVICE);
  return { category, status, events, newest: closing ? clock(closing) : '', booked: text(order.orderBookedDate ?? order.bookedDate, 40, 'date'), order };
}

/** "10/15/2026 18:45:00 -04:00" as an instant with its offset, "2026-10-15 08:00" as it is, or nothing. */
function windowEnd(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (WINDOW_WALL.test(raw)) return raw;
  const match = WINDOW_END.exec(raw);
  if (!match) return null;
  const day = calendarDay(Number(match[3]), Number(match[1]), Number(match[2]));
  return day ? `${day}T${match[4]}:${match[5]}:${match[6] ?? '00'}${match[7]}` : null;
}

/** The open appointment's window, or the day it is scheduled for. */
function estimate(order: Record<string, unknown>): Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> {
  const [from, to] = [windowEnd(order.deliveryServiceWindowStartTime), windowEnd(order.deliveryServiceWindowEndTime)];
  if (from && to) return windowEstimate(from, to);
  const scheduled = text(order.orderScheduledDate ?? order.scheduledDate, 40, 'date');
  return windowEstimate(/^\d{4}-\d{2}-\d{2}/.test(scheduled) ? scheduled.slice(0, 10) : null, null);
}

const same = (value: unknown, number: string) => typeof value === 'string' && normalizeTrackingNumber(value).toUpperCase() === number;

/**
 * The reply of `GET clm.rxo.com/trackapi/orders/trackbillto/<number>?billTo=0`, the lookup RXO's
 * tracking page makes: a list of orders, each a list of its appointments (work orders), or an
 * empty list for a number it holds no order under. Each appointment names the tracking number and
 * the sales order id, its status code and its events, on the wall clock of the hub's zone.
 *
 * The appointments of the order asked are read together: their events, newest first, give the
 * stage, and the newest appointment its status, window and retailer. Coordinates, addresses, items
 * and the retailer's references are never read.
 */
export function parseRxo(payload: unknown, raw: string): CarrierResult {
  const number = normalizeRxoNumber(raw);
  if (!Array.isArray(payload)) return invalid('RXO returned an unexpected reply');
  if (payload.length === 0) throw new NotFoundError(PROVIDER, 'RXO has no order under this number');
  const orders = payload.flatMap((group) => Array.isArray(group) ? group as unknown[] : invalid('RXO returned an unexpected reply'));
  if (orders.length === 0) return invalid('RXO returned an order without appointments');
  if (orders.length > MAX_ORDERS) return invalid('RXO returned too many appointments');
  for (const order of orders) {
    if (!isRecord(order) || typeof order.trackingNumber !== 'string') return invalid('RXO returned an appointment without its tracking number');
  }
  // The reply must name the number asked, as the order's tracking number or its sales order id.
  const asked = (orders as Record<string, unknown>[]).filter((order) => same(order.trackingNumber, number) || same(order.salesOrderId, number));
  if (asked.length === 0) throw new IndeterminateError(PROVIDER, 'RXO answered for another order');
  const appointments = asked.map(workOrderOf)
    .sort((a, b) => (b.newest || b.booked).localeCompare(a.newest || a.booked));
  const current = appointments[0]!;
  const events = appointments.flatMap((appointment) => appointment.events)
    .sort((a, b) => (b.local_time ?? b.time ?? '').localeCompare(a.local_time ?? a.time ?? ''));
  const retailer = text(isRecord(current.order.billTo) ? current.order.billTo.name : undefined, 80, 'retailer');
  const facts = retailer ? { sender_name: retailer } : {};
  const newest = events[0];
  if (current.status === 'CN') {
    return { status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map', provider_code: 'CN',
      last_status_text: 'Cancelled', last_update: newest?.time ?? null, ...(newest?.local_time ? { last_update_local: newest.local_time } : {}),
      expected_delivery: null, ...facts, events };
  }
  if (!newest) throw new NoHistoryError(PROVIDER, 'RXO lists the order without events', { reason: 'listed' });
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  const open = !stage || !FINAL.has(stage);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    ...(open && current.status !== 'DL' && current.category !== SERVICE ? estimate(current.order) : { expected_delivery: null }),
    ...facts,
    events,
  };
}

/** The tracker's reply as JSON, or the reason it is not one. */
export function rxoJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (isRxoBlocked(body)) throw new ChallengeError(PROVIDER, 'RXO answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'RXO returned a reply that is not JSON', { cause });
  }
}
