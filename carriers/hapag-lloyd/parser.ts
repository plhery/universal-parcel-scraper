import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, PlannedEvent } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { hapagStage } from './status.js';

export const PROVIDER = 'hapag-lloyd';
// A container's moves take about two kilobytes; a booking lists each of its containers.
export const HAPAG_MAX_BYTES = 512 * 1024;

/** What the tracking page looks up: a container by its ISO 6346 number, a booking or a bill of lading. */
export interface HapagQuery { kind: 'container' | 'booking' | 'bill'; reference: string }

// The forms the tracking page accepts.
const CONTAINER = /^[A-Z]{4}\d{7}$/;
const BOOKING = /^\d{1,8}$/;
const BILL = /^[A-Z]{4}[A-Z0-9]{12}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
// A move that has happened; a planned or estimated one is still due.
const ACTUAL = 'Actual';
const DUE = new Set(['Planned', 'Estimated']);
// The error keys of a reference the tracker does not hold, and of one that matches several shipments.
const NOT_FOUND = /^[a-z]+\.[a-z-]*not-found$/;
const AMBIGUOUS = 'dcsa.ambiguous-shipment-data';
const MAX_GROUPS = 200;
const MAX_ROWS = 300;
const MAX_EVENTS = 200;

// ISO 6346 values letters from 10 up, skipping multiples of 11.
const LETTER_VALUES: ReadonlyMap<string, number> = (() => {
  const values = new Map<string, number>();
  let value = 10;
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (value % 11 === 0) value++;
    values.set(letter, value++);
  }
  return values;
})();

/** The ISO 6346 check digit of a container's owner code, category and serial number. */
export function containerCheckDigit(body: string): number {
  return [...body].reduce((sum, char, index) => sum + (LETTER_VALUES.get(char) ?? Number(char)) * 2 ** index, 0) % 11 % 10;
}

/** The lookup for a number: a container with its check digit, a booking's digits or a bill of lading. */
export function hapagQuery(raw: string): HapagQuery {
  const reference = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (CONTAINER.test(reference)) {
    if (containerCheckDigit(reference.slice(0, 10)) !== Number(reference[10])) {
      throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
    }
    return { kind: 'container', reference };
  }
  if (BOOKING.test(reference)) return { kind: 'booking', reference };
  if (BILL.test(reference)) return { kind: 'bill', reference };
  throw new InvalidInputError(PROVIDER, 'Hapag-Lloyd tracks a container number, a booking number or a bill of lading');
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const text = (record: Record<string, unknown>, key: string, max = 200): string => {
  const value = record[key];
  if (value !== undefined && value !== null && typeof value !== 'string') return invalid(`Hapag-Lloyd returned an invalid ${key}`);
  return clean(value, max);
};

interface Move {
  readonly description: string;
  readonly location: string;
  readonly transport: string;
  readonly clock: string;
  readonly done: boolean;
}

function move(row: unknown, container: string): Move {
  if (!isRecord(row)) return invalid('Hapag-Lloyd returned an invalid container move');
  const owner = text(row, 'containerNumber', 20);
  // A vessel's departure and arrival name no container.
  if (owner && owner !== container) return invalid('Hapag-Lloyd returned another container\'s move');
  const description = text(row, 'eventDescription', 200), classifier = text(row, 'eventClassifierCode', 20);
  if (!description) return invalid('Hapag-Lloyd returned a move without its name');
  if (classifier !== ACTUAL && !DUE.has(classifier)) return invalid('Hapag-Lloyd returned a move neither done nor due');
  const day = DAY.exec(text(row, 'eventDate', 20));
  const date = day ? calendarDay(Number(day[1]), Number(day[2]), Number(day[3])) : null;
  if (!date) return invalid('Hapag-Lloyd returned an invalid move date');
  const rawTime = text(row, 'eventTime', 20), time = TIME.exec(rawTime);
  if (rawTime && !time) return invalid('Hapag-Lloyd returned an invalid move time');
  return { description, location: text(row, 'eventLocation', 200), transport: text(row, 'eventTransport', 60),
    clock: time ? `${date}T${time[1]}:${time[2]}:${time[3] ?? '00'}` : date, done: classifier === ACTUAL };
}

/**
 * Each move's stage. A gate move's wording does not say whether the container is empty or full,
 * so its place decides: before loading, the empty container goes out to the shipper and comes
 * back in loaded; after the last discharge, the first truck takes it out for delivery and its
 * next gate-in is the empty return. Other gate moves carry it between terminals.
 */
function stages(moves: readonly Move[]): (Stage | undefined)[] {
  const loaded = moves.findIndex(item => item.description === 'Loaded');
  let discharged = -1;
  moves.forEach((item, index) => { if (item.description === 'Discharged') discharged = index; });
  const arrived = discharged >= 0 && !moves.slice(discharged).some(item => item.description === 'Loaded');
  let gatedIn = false, outForDelivery = false;
  return moves.map((item, index): Stage | undefined => {
    const before = loaded < 0 || index < loaded;
    if (item.description === 'Gated out') {
      if (before) return gatedIn ? 'in_transit' : 'registered';
      if (arrived && index > discharged && !outForDelivery && item.transport === 'Truck') { outForDelivery = true; return 'out_for_delivery'; }
      return 'in_transit';
    }
    if (item.description === 'Gated in') {
      if (before) { const stage = gatedIn ? 'in_transit' : 'accepted'; gatedIn = true; return stage; }
      return outForDelivery ? 'delivered' : 'in_transit';
    }
    return hapagStage(item.description);
  });
}

interface Container {
  readonly number: string;
  readonly events: readonly CarrierEvent[];
  readonly planned: readonly PlannedEvent[];
}

/** A container's moves in Hapag-Lloyd's order, the oldest first, and the ones still due. */
function container(group: unknown): Container {
  if (!isRecord(group)) return invalid('Hapag-Lloyd returned an invalid container');
  const number = text(group, 'containerNumber', 20);
  if (!CONTAINER.test(number)) return invalid('Hapag-Lloyd returned a container without its number');
  if (!Array.isArray(group.events) || group.events.length > MAX_ROWS) return invalid('Hapag-Lloyd returned invalid container moves');
  const moves = group.events.map(row => move(row, number));
  const staged = stages(moves);
  const events: CarrierEvent[] = [], planned: PlannedEvent[] = [];
  moves.forEach((item, index) => {
    const stage = staged[index], location = item.location ? { location: item.location } : {};
    if (!item.done) planned.push({ local_time: item.clock, description: item.description, ...location, ...(stage ? { stage } : {}) });
    else events.push({ local_time: item.clock, description: item.description, ...location, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  });
  return { number, events, planned };
}

type Ordered = { event: CarrierEvent; order: number };
const newestFirst = (left: Ordered, right: Ordered) =>
  left.event.local_time! < right.event.local_time! ? 1 : left.event.local_time! > right.event.local_time! ? -1 : right.order - left.order;

/**
 * The move whose stage the shipment is at. A booking's containers move apart: one returned
 * empty does not make the others delivered, so a delivery decides only once every container has one.
 */
function currentMove(containers: readonly Container[]): CarrierEvent | undefined {
  const latest = containers.map(item => item.events.map((event, order) => ({ event, order }))
    .filter(({ event }) => event.stage).sort(newestFirst)[0]?.event);
  const open = latest.filter(event => event?.stage !== 'delivered');
  const candidates = (open.length ? open : latest).filter((event): event is CarrierEvent => event !== undefined);
  return candidates.map((event, order) => ({ event, order })).sort(newestFirst)[0]?.event;
}

/** The error a refused lookup's key names: a reference Hapag-Lloyd does not hold, or one that matches several shipments. */
export function hapagRefusal(body: string): Error | undefined {
  let reply: unknown;
  try { reply = JSON.parse(body); } catch { return undefined; }
  const key = isRecord(reply) && typeof reply.errorKey === 'string' ? reply.errorKey : '';
  if (NOT_FOUND.test(key)) return new NotFoundError(PROVIDER, 'Hapag-Lloyd does not hold this reference');
  if (key === AMBIGUOUS) return new IndeterminateError(PROVIDER, 'Hapag-Lloyd matches this reference to several shipments');
  return undefined;
}

/**
 * The containers' moves the tracking page shows for a reference: each container of a booking or
 * bill of lading, or the container asked for, with its moves done and due.
 */
export function parseHapag(body: string, query: HapagQuery): CarrierResult {
  let reply: unknown;
  try { reply = JSON.parse(body); } catch (cause) { throw new SchemaError(PROVIDER, 'Hapag-Lloyd returned a reply that is not JSON', { cause }); }
  if (!isRecord(reply) || !Array.isArray(reply.groups) || reply.groups.length > MAX_GROUPS) return invalid('Hapag-Lloyd returned an invalid reply');
  if (!reply.groups.length) throw new NotFoundError(PROVIDER, 'Hapag-Lloyd does not hold this reference');
  let containers = reply.groups.map(container);
  if (query.kind === 'container') {
    containers = containers.filter(item => item.number === query.reference);
    if (!containers.length) throw new IndeterminateError(PROVIDER, 'Hapag-Lloyd answered for another container');
  }

  const seen = new Set<string>();
  const events = containers.flatMap((item, index) => item.events.map((event, row) => ({ event, order: index * MAX_ROWS + row })))
    .sort(newestFirst)
    // A booking's containers share their vessels' departures and arrivals: each is kept once.
    .filter(({ event }) => {
      const key = JSON.stringify([event.local_time, event.description, event.location ?? '']);
      return !seen.has(key) && Boolean(seen.add(key));
    })
    .map(({ event }) => event);
  const due = new Set<string>();
  const planned = containers.flatMap(item => item.planned).filter(step => {
    const key = JSON.stringify([step.local_time, step.description, step.location ?? '']);
    return !due.has(key) && Boolean(due.add(key));
  });
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Hapag-Lloyd lists the shipment without moves', { reason: 'listed' });
  const newest = events[0]!;
  const current = currentMove(containers);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current ? { current_stage: stage, current_stage_source: current.stage_source } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, expected_delivery: null,
    ...(planned.length ? { planned_events: planned } : {}),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}), events: events.slice(0, MAX_EVENTS),
  };
}
