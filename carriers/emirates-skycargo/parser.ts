import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { arrivalStages, emiratesSkyCargoStage, emiratesSkyCargoWording } from './status.js';

export const provider = 'emirates-skycargo';
export const PREFIX = '176';

const AIRPORT = /^[A-Z]{3}$/;
const CODE = /^[A-Z]{3,4}$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const MAX_ITEMS = 50;
const MAX_MILESTONES = 500;

/** Emirates' prefix 176, then an eight-digit serial ending in the first seven digits' remainder by seven. */
export function normalizeEmiratesSkyCargoNumber(raw: string): string {
  const [, serial = ''] = /^(?:176[\s-]?)?(\d{8})$/.exec(typeof raw === 'string' ? raw.trim() : '') ?? [];
  if (!serial || !hasMod7CheckDigit(serial)) {
    throw new InvalidInputError(provider, 'Enter an Emirates SkyCargo air waybill beginning with 176');
  }
  return PREFIX + serial;
}

const invalid = (message: string): never => { throw new SchemaError(provider, message); };
const field = (node: unknown, key: string): unknown => isRecord(node) ? node[key] : undefined;

/** The waybill an order item names, as prefix and serial. */
function waybillOf(item: Record<string, unknown>): string {
  const document = field(field(field(item, 'productInfo'), 'airCapacity'), 'documentInfo');
  return `${cleanScalar(field(document, 'documentPrefix'), 3)}${cleanScalar(field(document, 'documentNumber'), 8)}`;
}

function itemsOf(orders: unknown[]): Record<string, unknown>[] {
  const items = orders.flatMap((order): unknown[] => {
    const list: unknown = field(field(order, 'orderItems'), 'orderItem');
    return Array.isArray(list) ? list as unknown[] : invalid('Emirates SkyCargo returned an order without items');
  });
  if (items.length > MAX_ITEMS) return invalid('Emirates SkyCargo returned too many order items');
  return items.filter(isRecord);
}

/** The order item for the requested waybill, preferring one still in force. */
function itemFor(items: Record<string, unknown>[], number: string): Record<string, unknown> {
  const matching = items.filter(item => waybillOf(item) === number);
  if (!matching.length) throw new IndeterminateError(provider, 'Emirates SkyCargo answered without the requested air waybill');
  const inForce = (item: Record<string, unknown>) => field(item.status, 'voided') !== true && field(item.status, 'cancelled') !== true;
  return matching.find(inForce) ?? matching[0]!;
}

const succeeded = (data: unknown): data is { data: unknown } => isRecord(data) && data.status === 'success';

/**
 * Reads `POST /orders/actions/search?view=summary`: the booking that holds the waybill, whose
 * reference opens its milestones. The search answers an unknown waybill with HTTP 404 and
 * `BOOKING_NOT_FOUND`, which the adapter reads before this.
 */
export function bookingReference(data: unknown, number: string): string {
  if (!succeeded(data)) return invalid('Emirates SkyCargo returned an unreadable search');
  const orders = field(data.data, 'order');
  if (!Array.isArray(orders)) return invalid('Emirates SkyCargo returned a search without orders');
  const item = itemFor(itemsOf(orders), number);
  const reference = cleanScalar(field(item.reference, 'bookingReferenceNumber'), 20);
  return /^\d{1,15}$/.test(reference) ? reference : invalid('Emirates SkyCargo returned a booking without its reference');
}

/** The search's not-found answer: HTTP 404 with this error code. */
export function bookingNotFound(data: unknown): boolean {
  const errors = field(data, 'errors');
  return field(data, 'status') === 'failure' && Array.isArray(errors)
    && errors.some(error => field(error, 'error_code') === 'BOOKING_NOT_FOUND');
}

function eventOf(milestone: unknown): CarrierEvent & { description: string } {
  if (!isRecord(milestone)) return invalid('Emirates SkyCargo returned an invalid milestone');
  const code = clean(field(milestone.code, 'code'), 10).toUpperCase();
  if (!CODE.test(code)) return invalid('Emirates SkyCargo returned an invalid milestone code');
  const clock = WALL_CLOCK.exec(clean(field(milestone.statusDate, 'achieved'), 40));
  if (!clock) return invalid('Emirates SkyCargo returned an unreadable milestone time');
  const station = clean(field(milestone.station, 'code'), 10).toUpperCase();
  const stage = emiratesSkyCargoStage(code);
  return {
    // The station's wall clock: `achievedUTC` sits hours off the flights' own UTC times.
    local_time: `${clock[1]}T${clock[2]}`,
    description: clean(field(milestone.code, 'description'), 300) || emiratesSkyCargoWording(code) || code,
    provider_code: code,
    ...(AIRPORT.test(station) && { location: station }),
    ...(stage && { stage, stage_source: 'carrier_map' as const }),
  };
}

/**
 * Reads `GET /orders/b<booking reference>`: the booking's order item for the waybill, with its
 * milestones in Emirates' own sequence, the latest first, each on its station's clock.
 */
export function parseEmiratesSkyCargo(data: unknown, number: string): CarrierResult {
  if (!succeeded(data) || !isRecord(data.data)) return invalid('Emirates SkyCargo returned an unreadable booking');
  const item = itemFor(itemsOf([data.data]), number);
  const milestones = field(field(item.fulfillmentInfo, 'serviceInfo'), 'milestone') ?? [];
  if (!Array.isArray(milestones) || milestones.length > MAX_MILESTONES) return invalid('Emirates SkyCargo returned invalid milestones');

  const destination = clean(field(field(field(item.productInfo, 'airCapacity'), 'destination'), 'code'), 10).toUpperCase();
  const seen = new Set<string>();
  // Stations write on their own clocks, so the reply's order is the history's order.
  const events = milestones.map(eventOf).filter(event => {
    const key = JSON.stringify([event.provider_code, event.description, event.local_time, event.location]);
    return !seen.has(key) && Boolean(seen.add(key));
  });
  for (const event of events) {
    // A notice or a delivery away from the destination is a step on the way.
    if (AIRPORT.test(destination) && event.location && event.location !== destination && arrivalStages.has(event.stage as Stage)) {
      event.stage = 'in_transit';
    }
  }
  if (!events.length) throw new NoHistoryError(provider, 'Emirates SkyCargo lists the air waybill without milestones', { reason: 'listed' });
  // A milestone recorded after the delivery does not take it back.
  const current = events.find(event => event.stage === 'delivered') ?? events.find(event => event.stage) ?? events[0]!;
  const stage = current.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: current.description,
    ...(current.provider_code && { provider_code: current.provider_code }),
    last_update: null,
    ...(current.local_time && { last_update_local: current.local_time }),
    events,
  };
}
