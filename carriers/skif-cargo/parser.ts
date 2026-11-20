import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, PlannedEvent } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { skifStage } from './status.js';

export const PROVIDER = 'Skif-Cargo';
// The tracking page is about 22 kB.
export const SKIF_PAGE_MAX_BYTES = 512 * 1024;
// A shipment's reply is under 2 kB; the account check's under 100 bytes.
export const SKIF_MAX_BYTES = 256 * 1024;
const MAX_POINTS = 100;
// An application number, which the tracker shows as five digits, " - " and four, and finds by its digits alone.
const NUMBER = /^\d{6,12}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// The issue's clock, as the reply writes it: DD.MM.YYYY HH:mm:ss.
const ISSUED = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;
// The page's points: the sender's and the consignee's addresses, and the warehouses between.
const AT_ADDRESS = 0;
// A point the shipment has not reached; the page draws it as ahead and dates the last one as the expected delivery.
const PLANNED = 0;

/** An application number's digits; the tracker's own reference also takes a customer's order number, which the adapter does not. */
export function normalizeSkifNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Skif-Cargo shipments are tracked by the digits of their application number');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Skif-Cargo returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** Whether the digits name a real calendar day and time of day. */
function onCalendar(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): boolean {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}

/** A point's day, YYYY-MM-DD, or '' for a point the page shows without one. */
function pointDay(row: Record<string, unknown>): string {
  const day = text(row, 'point_date', 16);
  if (!day) return '';
  const parts = DAY.exec(day);
  if (!parts || !onCalendar(Number(parts[1]), Number(parts[2]), Number(parts[3]))) {
    throw new SchemaError(PROVIDER, 'Skif-Cargo returned an invalid point date');
  }
  return day;
}

/**
 * The issue's wall clock. The reply names no zone, and the route can cross several of Russia's
 * eleven, so it stays a wall clock.
 */
function issueClock(order: Record<string, unknown>): string {
  const value = text(order, 'CompleteDate', 32);
  if (!value) return '';
  const parts = ISSUED.exec(value);
  if (!parts) throw new SchemaError(PROVIDER, 'Skif-Cargo returned an invalid issue time');
  const [day, month, year, hour, minute, second] = parts.slice(1).map(Number);
  if (!onCalendar(year!, month!, day!, hour, minute, second)) throw new SchemaError(PROVIDER, 'Skif-Cargo returned an invalid issue time');
  return `${parts[3]}-${parts[2]}-${parts[1]}T${parts[4]}:${parts[5]}:${parts[6]}`;
}

/** The application the reply names, as digits: its short number, and its full one. */
function names(order: Record<string, unknown>): string[] {
  const short = text(order, 'OrderShortNo', 40);
  const full = order.OrderNo;
  if (!/^\d+(?: ?- ?\d+)?$/.test(short) || (full !== null && full !== undefined && !(Number.isSafeInteger(full) && (full as number) > 0))) {
    throw new SchemaError(PROVIDER, 'Skif-Cargo returned a shipment without its number');
  }
  return [short.replace(/\D/g, ''), ...(typeof full === 'number' ? [String(full)] : [])];
}

/** The weight in kilograms the tracker measured, when it gives one. */
function weightKg(order: Record<string, unknown>): { weight_kg?: number } {
  const weight = order.FactWeight;
  if (weight !== null && weight !== undefined && (typeof weight !== 'number' || !Number.isFinite(weight))) {
    throw new SchemaError(PROVIDER, 'Skif-Cargo returned an invalid weight');
  }
  return typeof weight === 'number' && weight > 0 ? { weight_kg: weight } : {};
}

/**
 * The tracker's reply for one number: the application with its state, and the points of its route
 * in order, each reached or still ahead. `order_tracking` is null for a number the tracker does not
 * know.
 */
export function parseSkif(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSkifNumber(raw);
  if (!isRecord(payload) || !('order_tracking' in payload) || !Array.isArray(payload.points)) {
    throw new SchemaError(PROVIDER, 'Skif-Cargo returned an invalid reply');
  }
  const order = payload.order_tracking;
  if (order === null) {
    if (payload.points.length) throw new SchemaError(PROVIDER, 'Skif-Cargo returned points without a shipment');
    throw new NotFoundError(PROVIDER);
  }
  if (!isRecord(order)) throw new SchemaError(PROVIDER, 'Skif-Cargo returned an invalid shipment');
  if (!names(order).includes(number)) throw new IndeterminateError(PROVIDER, 'Skif-Cargo answered for another shipment');
  if (payload.points.length > MAX_POINTS) throw new SchemaError(PROVIDER, 'Skif-Cargo returned an oversized route');

  const scans: { order: string; index: number; event: CarrierEvent }[] = [];
  const planned: PlannedEvent[] = [];
  // The page shows the last point's day as the expected delivery while that address is still ahead.
  let expected = '';
  for (const [index, row] of payload.points.entries()) {
    if (!isRecord(row) || !Number.isInteger(row.point_type) || !Number.isInteger(row.point_status)) {
      throw new SchemaError(PROVIDER, 'Skif-Cargo returned an invalid point');
    }
    const description = text(row, 'point_message', 200);
    if (!description) throw new SchemaError(PROVIDER, 'Skif-Cargo returned a point without wording');
    const location = text(row, 'city_name', 120);
    const day = pointDay(row);
    const staged = skifStage(description);
    if (row.point_status === PLANNED) {
      if (!day) continue;
      planned.push({ local_time: day, description, ...(location ? { location } : {}), ...(staged ? { stage: staged.stage } : {}) });
      if (index === payload.points.length - 1 && row.point_type === AT_ADDRESS) expected = day;
      continue;
    }
    // A reached point the page shows without a day has no clock to stand at.
    if (!day) continue;
    scans.push({ order: day, index, event: {
      local_time: day,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }

  // The state names the shipment as the page shows it; once issued, the reply gives the issue's clock.
  const state = text(order, 'CurrCargoState', 200);
  const current = state ? skifStage(state) : null;
  const issued = issueClock(order);
  if (issued && current?.stage === 'delivered') {
    const destination = text(order, 'RecipTownName', 120);
    scans.push({ order: issued, index: payload.points.length, event: {
      local_time: issued,
      ...(destination ? { location: destination } : {}),
      description: state,
      stage: current.stage,
      stage_source: current.source,
    } });
  }
  // Newest first; a time of day comes after its day, and points of one day keep the route's order.
  scans.sort((left, right) => right.order.localeCompare(left.order) || right.index - left.index);
  const events = scans.map(scan => scan.event);
  const delivered = current?.stage === 'delivered' || events.some(event => event.stage === 'delivered');
  const estimate = delivered ? {} : { expected_delivery: expected || null };
  const plannedSteps = delivered || !planned.length ? {} : { planned_events: planned };

  if (!events.length) {
    if (!current) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed', plannedEvents: planned });
    return { status: languageStageStatus(current.stage), current_stage: current.stage, current_stage_source: current.source,
      last_status_text: state, last_update: null, expected_delivery: null, ...estimate, ...plannedSteps, ...weightKg(order), summary_only: true, events: [] };
  }
  const scanned = events.find(event => event.stage);
  const stage = (current?.stage ?? scanned?.stage) as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current?.source ?? scanned!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: state || events[0]!.description!,
    last_update: null,
    last_update_local: scans[0]!.order,
    expected_delivery: null,
    ...estimate,
    ...plannedSteps,
    ...weightKg(order),
    events,
  };
}
