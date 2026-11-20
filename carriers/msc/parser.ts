import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { plannedEvents } from '../../core/result/planned.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { mscStage } from './status.js';

export const PROVIDER = 'MSC';
/** The tracking page, which searches for the number its `params` name. */
export const MSC_PAGE = 'https://www.msc.com/en/track-a-shipment';
/** The lookup that page posts the number and its mode to. */
export const MSC_LOOKUP = 'https://www.msc.com/api/feature/tools/TrackingInfo';
export const MSC_MAX_BYTES = 1_000_000;

const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
// MSC's bills of lading are MEDU, its carrier code, and eight characters.
const BILL = /^MEDU(?=[A-Z]*\d)[A-Z0-9]{8}$/;
const BOOKING = /^(?=[A-Z]*\d)[A-Z0-9]{6,20}$/;
const DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const MAX_BILLS = 50;
const MAX_CONTAINERS = 200;
const MAX_ROWS = 500;
const MAX_EVENTS = 200;
const EARLIEST_YEAR = 2001;
const LATEST_YEAR = 2100;

/**
 * What MSC's page tracks: a container by its ISO 6346 number or a bill of lading, which it
 * looks up in one mode, or a booking, in the other.
 */
export type MscQuery = { kind: 'container' | 'bill' | 'booking'; number: string };

// Letters count from 10 and skip the multiples of 11: A is 10, B 12, L 23, Z 38.
const LETTER_VALUES = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter, index) => [letter, 10 + index + Math.floor((index + 9) / 10)]));

/** The ISO 6346 check digit of a container's owner code, category and serial number. */
export function containerCheckDigit(body: string): number {
  if (!/^[A-Z]{3}[UJZ]\d{6}$/.test(body)) throw new InvalidInputError(PROVIDER, 'Container numbers are an owner code, a category letter and six digits');
  const sum = [...body].reduce((total, character, index) => total + (LETTER_VALUES.get(character) ?? Number(character)) * 2 ** index, 0);
  return sum % 11 % 10;
}

/** A whole container number with its check digit, a bill of lading with `MEDU`, or a booking. */
export function mscQuery(raw: string): MscQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (CONTAINER.test(number)) {
    if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
    return { kind: 'container', number };
  }
  if (BILL.test(number)) return { kind: 'bill', number };
  // MEDU begins MSC's bills and its own containers; a code that is neither is a mistyped one, not a booking.
  if (BOOKING.test(number) && !number.startsWith('MEDU')) return { kind: 'booking', number };
  throw new InvalidInputError(PROVIDER, 'MSC tracks a container number, a bill of lading or a booking');
}

/** The page's mode: `0` for a container or a bill of lading, `1` for a booking. */
export const mscMode = (query: MscQuery) => query.kind === 'booking' ? '1' : '0';
/** The JSON the page posts for the number. */
export const mscRequestBody = (query: MscQuery) => JSON.stringify({ trackingNumber: query.number, trackingMode: mscMode(query) });
/** The page's link to the number, its search in base64 as the page reads it. */
export const mscPageUrl = (query: MscQuery) =>
  `${MSC_PAGE}?${new URLSearchParams({ params: btoa(new URLSearchParams({ trackingNumber: query.number, trackingMode: mscMode(query) }).toString()) })}`;

// How the reply names each kind of number, in its type and in its answer for one it does not hold.
const TYPES: Readonly<Record<MscQuery['kind'], string>> = { container: 'Container', bill: 'Bill Of Lading', booking: 'Booking Number' };
const LABELS: Readonly<Record<MscQuery['kind'], string>> = { container: 'Container number', bill: 'Bill of Lading number', booking: 'Booking number' };

const text = (record: Record<string, unknown>, key: string, maxLength = 200): string => {
  const value = record[key];
  if (value !== null && value !== undefined && typeof value !== 'string') throw new SchemaError(PROVIDER, `MSC returned an invalid ${key}`);
  return clean(value, maxLength);
};
const rowsOf = (record: Record<string, unknown>, key: string, max: number): Record<string, unknown>[] => {
  const value = record[key];
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || !value.every(isRecord)) throw new SchemaError(PROVIDER, `MSC returned an invalid ${key}`);
  return value;
};

/** A day the reply writes as dd/MM/yyyy, as the page reads it. */
function dayOf(value: unknown, field: string): string {
  const match = typeof value === 'string' ? DAY.exec(value.trim()) : null;
  const day = match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
  const year = Number(day?.slice(0, 4));
  if (!day || year < EARLIEST_YEAR || year > LATEST_YEAR) throw new SchemaError(PROVIDER, `MSC returned an invalid ${field}`);
  return day;
}

// The stages of a container that has not moved yet.
const BEFORE_MOVING: ReadonlySet<string> = new Set<Stage>(['pending', 'registered', 'accepted']);

interface ContainerHistory { readonly events: CarrierEvent[]; readonly planned: CarrierEvent[] }

/**
 * A container's moves, newest first in the reply's order, each on its day. A move dated after
 * the reply's day, or an estimate, is a planned step, as the page greys it. An empty container
 * received before it moved is an unused one's return, no delivery; a gate in after it moved is
 * transit.
 */
function containerHistory(container: Record<string, unknown>, today: string): ContainerHistory {
  const rows = rowsOf(container, 'Events', MAX_ROWS).map(row => {
    const order = row.Order;
    if (typeof order !== 'number' || !Number.isSafeInteger(order) || order < 0) throw new SchemaError(PROVIDER, 'MSC returned an invalid Order');
    const local = dayOf(row.Date, 'event date');
    const description = text(row, 'Description');
    if (!description) throw new SchemaError(PROVIDER, 'MSC returned a move without a description');
    const handling = row.EquipmentHandling;
    if (handling !== null && handling !== undefined && !isRecord(handling)) throw new SchemaError(PROVIDER, 'MSC returned an invalid EquipmentHandling');
    const location = [handling ? text(handling, 'Name', 120) : '', text(row, 'Location', 120)].filter(Boolean).join(', ');
    const stage = mscStage(description);
    const event: CarrierEvent = { local_time: local, ...(location ? { location } : {}), description,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    return { order, event, planned: local > today || /^estimated\b/i.test(description) };
  }).sort((left, right) => right.order - left.order);
  const events = rows.filter(row => !row.planned).map(row => row.event);
  let moved = false;
  for (const event of [...events].reverse()) {
    if (!moved && event.stage === 'delivered') {
      delete event.stage;
      delete event.stage_source;
    }
    if (moved && event.stage && BEFORE_MOVING.has(event.stage)) event.stage = 'in_transit';
    if (event.stage && !BEFORE_MOVING.has(event.stage)) moved = true;
  }
  // Planned steps go oldest first, so those on one day keep their order.
  return { events, planned: rows.filter(row => row.planned).map(row => row.event).reverse() };
}

/**
 * The stage the shipment is at. A bill's containers move apart: one returned empty does not
 * make the others delivered, so a delivery decides only once every container has one, and a
 * container without a staged move leaves the stage open.
 */
function currentStage(histories: readonly ContainerHistory[]): Stage | undefined {
  const latest = histories.map(item => item.events.find(event => event.stage));
  const open = latest.filter((event): event is CarrierEvent => event !== undefined && event.stage !== 'delivered')
    .sort((left, right) => right.local_time!.localeCompare(left.local_time!))[0];
  if (open) return open.stage as Stage;
  return latest.length && latest.every(event => event !== undefined) ? 'delivered' : undefined;
}

/**
 * MSC's reply for a container, bill of lading or booking: each container's moves merged newest
 * first, the moves they share kept once. The reply must be for the number and its kind; a bill's
 * must list that bill alone, and a container's is read for that container alone. MSC's answer for
 * a number it does not hold names the kind it looked for.
 */
export function mscResult(reply: unknown, query: MscQuery): CarrierResult {
  if (!isRecord(reply) || typeof reply.IsSuccess !== 'boolean') throw new SchemaError(PROVIDER, 'MSC returned a reply that is not its tracking answer');
  if (!reply.IsSuccess) {
    const message = typeof reply.Data === 'string' ? clean(reply.Data, 300) : '';
    if (message.startsWith(`No results found for this ${LABELS[query.kind]}.`)) {
      throw new NotFoundError(PROVIDER, query.kind === 'container' ? 'MSC does not hold this container'
        : query.kind === 'bill' ? 'MSC does not hold this bill of lading' : 'MSC does not hold this booking');
    }
    if (message.startsWith('No results found for this ')) throw new SchemaError(PROVIDER, 'MSC looked up another kind of number');
    throw new TransportError(PROVIDER, 'MSC could not answer the lookup');
  }
  const data = reply.Data;
  if (!isRecord(data) || text(data, 'TrackingType', 40) !== TYPES[query.kind]) throw new SchemaError(PROVIDER, 'MSC returned another kind of lookup');
  if (text(data, 'TrackingNumber', 40) !== query.number) throw new SchemaError(PROVIDER, 'MSC returned another number');
  const today = dayOf(data.CurrentDate, 'CurrentDate');
  const bills = rowsOf(data, 'BillOfLadings', MAX_BILLS);
  if (query.kind === 'bill' && bills.some(bill => text(bill, 'BillOfLadingNumber', 40) !== query.number)) {
    throw new SchemaError(PROVIDER, 'MSC returned another bill of lading');
  }
  let containers = bills.flatMap(bill => rowsOf(bill, 'ContainersInfo', MAX_CONTAINERS));
  if (containers.length > MAX_CONTAINERS) throw new SchemaError(PROVIDER, 'MSC returned too many containers');
  if (query.kind === 'container') {
    containers = containers.filter(container => text(container, 'ContainerNumber', 20) === query.number);
    if (!containers.length) throw new SchemaError(PROVIDER, 'MSC returned another container');
  }
  const histories = containers.map(container => containerHistory(container, today));
  const planned = plannedEvents(histories.flatMap(item => item.planned));
  const seen = new Set<string>();
  const events = histories.flatMap(item => item.events)
    .sort((left, right) => right.local_time!.localeCompare(left.local_time!))
    .filter(event => {
      const key = JSON.stringify([event.local_time, event.description, event.location ?? '']);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (!events.length) {
    throw new NoHistoryError(PROVIDER, 'MSC lists the shipment without moves', { reason: 'listed', ...(planned.length ? { plannedEvents: planned } : {}) });
  }
  const newest = events[0]!;
  const stage = currentStage(histories);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description ?? null, last_update: null, last_update_local: newest.local_time!,
    expected_delivery: null, ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}), events: events.slice(0, MAX_EVENTS),
    ...(planned.length ? { planned_events: planned } : {}),
  };
}

// Akamai's refusal: its own page, or an empty reply where MSC sends JSON.
const REFUSED = /<title>\s*Access Denied|errors\.edgesuite\.net/i;

/** The lookup's reply body, read as MSC's answer for the number; Akamai's refusal is a challenge. */
export function mscReplyText(body: string, query: MscQuery): CarrierResult {
  if (!body.trim()) throw new ChallengeError(PROVIDER, 'Akamai answered MSC\'s lookup with an empty reply');
  let reply: unknown;
  try {
    reply = JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (REFUSED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Akamai refused MSC\'s tracking lookup');
    throw new SchemaError(PROVIDER, 'MSC returned tracking data that is not JSON', { cause });
  }
  return mscResult(reply, query);
}
