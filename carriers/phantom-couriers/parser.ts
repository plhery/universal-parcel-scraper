import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { epochSecondsTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { PHANTOM_LABELS, phantomShipmentStage } from './status.js';

export const PROVIDER = 'Phantom Couriers';
// One order is a few kilobytes of JSON.
export const PHANTOM_MAX_BYTES = 256 * 1024;

// The portal sends any number of five characters or more; Phantom's own are short counters.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{5,20}$/;
const SECONDS = /^\d{9,10}$/;
const CODE = /^[A-Z][A-Z_]{0,39}$/;
const STOP_TYPES = new Set(['PICK_UP', 'DROP_OFF', 'RETURN']);
const BUSY = /too many|rate limit/i;
const MAX_STOPS = 40;

/** A Phantom order number in upper case, as the portal sends it; anything else is not one Phantom issues. */
export function normalizePhantomNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Phantom order numbers are five to twenty letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 80): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Phantom returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An optional enumeration value, as GraphQL spells it. */
function code(row: Record<string, unknown>, key: string): string {
  const value = text(row, key, 40);
  if (value && !CODE.test(value)) throw new SchemaError(PROVIDER, `Phantom returned an invalid ${key}`);
  return value;
}

/** An optional instant, which the API gives as epoch seconds in a string. */
function instant(row: Record<string, unknown>, key: string): { iso: string; at: number } | null {
  const value = row[key];
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'string' && SECONDS.test(value) ? epochSecondsTime(value) : null;
  if (!parsed) throw new SchemaError(PROVIDER, `Phantom returned an invalid ${key}`);
  return { iso: parsed.iso, at: parsed.timestamp };
}

/** A stop's city and province, as the portal names the place; the street stays out. */
function place(stop: Record<string, unknown>): Pick<CarrierEvent, 'location'> {
  const location = [text(stop, 'city'), text(stop, 'state', 40)].filter(Boolean).join(', ');
  return location ? { location } : {};
}

/** The order of a stop on its route: its first task's sequence number, as the portal sorts stops. */
function sequence(stop: Record<string, unknown>): number {
  const tasks = stop.tasks ?? [];
  if (!Array.isArray(tasks)) throw new SchemaError(PROVIDER, 'Phantom returned invalid stop tasks');
  const first: unknown = tasks[0];
  if (first === undefined) return 0;
  if (!isRecord(first) || (first.sequenceNumber !== null && first.sequenceNumber !== undefined && typeof first.sequenceNumber !== 'number')) {
    throw new SchemaError(PROVIDER, 'Phantom returned an invalid stop task');
  }
  return typeof first.sequenceNumber === 'number' && Number.isFinite(first.sequenceNumber) ? first.sequenceNumber : 0;
}

/** One milestone, labelled and staged by the status map's labels. */
function milestone(key: keyof typeof PHANTOM_LABELS, time: { iso: string; at: number }, where: Pick<CarrierEvent, 'location'> = {}):
  { at: number; event: CarrierEvent } {
  const label = PHANTOM_LABELS[key];
  return { at: time.at, event: { time: time.iso, description: label.description, provider_code: label.code, ...where,
    stage: label.stage, stage_source: 'carrier_map' } };
}

/**
 * The milestones the order's record dates: its creation, its driver, and each stop
 * the driver completed. A task's arrival is left out: the record can date the
 * arrival at a drop-off before the pick-up it follows.
 */
function milestones(shipment: Record<string, unknown>, stops: Record<string, unknown>[]): { at: number; event: CarrierEvent }[] {
  const rows: { at: number; event: CarrierEvent }[] = [];
  const created = instant(shipment, 'createdAt');
  if (created) rows.push(milestone('created', created));
  const assigned = instant(shipment, 'assignedAt');
  if (assigned) rows.push(milestone('assigned', assigned));
  for (const stop of stops) {
    const completed = instant(stop, 'completedAt');
    if (!completed) continue;
    const type = code(stop, 'type');
    const where = place(stop);
    if (type === 'PICK_UP') rows.push(milestone('picked_up', completed, where));
    else if (type === 'RETURN') rows.push(milestone('returned', completed, where));
    else rows.push(milestone(code(stop, 'completionReason') === 'ATTEMPTED' ? 'attempted' : 'delivered', completed, where));
  }
  // Newest first; equal times keep the route's order, the later stop first.
  return rows.map((row, index) => ({ ...row, index })).sort((left, right) => right.at - left.at || right.index - left.index);
}

/**
 * The reply of the guest portal's query for one order of the courier: the order's
 * number, status, how it was completed, when it was created and given to a driver,
 * and its stops, each a pick-up, drop-off or return with its city and when the
 * driver completed it. An order the courier does not hold is `null`. The order must
 * be the number asked.
 */
export function parsePhantom(payload: unknown, raw: string): CarrierResult {
  const number = normalizePhantomNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Phantom returned an invalid envelope');
  if (Array.isArray(payload.errors) && payload.errors.length) {
    const message = payload.errors.map((error) => clean(isRecord(error) ? error.message : '', 200)).join(' ');
    if (BUSY.test(message)) throw new RateLimitedError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Phantom did not complete the lookup');
  }
  if (!isRecord(payload.data) || !('shipmentByTrackingNumber' in payload.data)) {
    throw new SchemaError(PROVIDER, 'Phantom returned an invalid envelope');
  }
  const shipment = payload.data.shipmentByTrackingNumber;
  // The portal reads an empty answer as "Invalid Tracking Number": no order of the courier has it.
  if (shipment === null) throw new NotFoundError(PROVIDER);
  if (!isRecord(shipment)) throw new SchemaError(PROVIDER, 'Phantom returned an invalid order');
  if (normalizeTrackingNumber(text(shipment, 'trackingNumber', 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'Phantom answered for another order');
  }
  const stops = shipment.stops ?? [];
  if (!Array.isArray(stops) || stops.length > MAX_STOPS || !stops.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'Phantom returned invalid stops');
  }
  for (const stop of stops) {
    if (!STOP_TYPES.has(code(stop, 'type'))) throw new SchemaError(PROVIDER, 'Phantom returned a stop of an unknown type');
  }
  const route = (stops as Record<string, unknown>[]).map((stop, index) => ({ stop, index, order: sequence(stop) }))
    .sort((left, right) => left.order - right.order || left.index - right.index).map(({ stop }) => stop);
  const events = milestones(shipment, route).map(({ event }) => event);
  const status = code(shipment, 'status');
  if (!status) throw new SchemaError(PROVIDER, 'Phantom returned an order without a status');
  const listed = phantomShipmentStage(status, code(shipment, 'completionReason'), code(shipment, 'holdStatus'));
  const newest = events[0];
  // The order's status leads, as the portal shows it; a status it does not name leaves the newest milestone's stage.
  const current: { stage: Stage; text: string } | null = listed
    ? { stage: listed.stage, text: listed.text }
    : newest ? { stage: newest.stage as Stage, text: newest.description! } : null;
  return {
    status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current?.text ?? status,
    last_update: newest?.time ?? null,
    provider_code: status,
    events,
  };
}
