import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, PlannedEvent } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { turkonStage } from './status.js';

export const PROVIDER = 'turkon-line';
// A container's moves take about a kilobyte; a booking lists each of its containers.
export const TURKON_MAX_BYTES = 512 * 1024;

/** What the tracking page looks up: a container by its ISO 6346 number, or a booking. */
export type TurkonQuery = { kind: 'container'; number: string } | { kind: 'booking'; number: string };

const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
// A booking is digits, some behind an office's letters.
const BOOKING = /^(?:[A-Z]{2,3})?\d{6,10}$/;
// A bill of lading is Turkon's carrier code before the booking's digits; the tracker holds the booking.
const BILL = /^TRKU(\d{6,10})$/;
const DAY = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
const CODE = /^[A-Z0-9]{2,6}$/;
// A move that has not happened: the day it is due, without a time.
const PLANNED = '3';
const MAX_CONTAINERS = 200;
const MAX_ROWS = 300;
const MAX_EVENTS = 200;
// Moves after which the container has sailed.
const SAILED = new Set(['LDF', 'DCF']);

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

/** The lookup for a number: a container with its check digit, a booking, or a TRKU bill of lading as its booking. */
export function turkonQuery(raw: string): TurkonQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (CONTAINER.test(number)) {
    if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
    return { kind: 'container', number };
  }
  const bill = BILL.exec(number);
  if (bill) return { kind: 'booking', number: bill[1]! };
  if (BOOKING.test(number)) return { kind: 'booking', number };
  throw new InvalidInputError(PROVIDER, 'Turkon Line tracks a container number, a booking number or a TRKU bill of lading');
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const text = (record: Record<string, unknown>, key: string, max = 200): string => {
  const value = record[key];
  if (value !== undefined && value !== null && typeof value !== 'string') return invalid(`Turkon Line returned an invalid ${key}`);
  return clean(value, max);
};
const withoutZeros = (value: string) => value.replace(/^0+(?=.)/, '');

function dayOf(value: string): string {
  const parts = DAY.exec(value);
  const day = parts && Number(parts[3]) > 2000 ? calendarDay(Number(parts[3]), Number(parts[2]), Number(parts[1])) : null;
  return day ?? invalid('Turkon Line returned an invalid move date');
}

interface Container {
  readonly number: string;
  readonly events: readonly CarrierEvent[];
  readonly planned: readonly PlannedEvent[];
}

/** A container's moves in Turkon's order, the oldest first, and the ones still due. */
function container(record: Record<string, unknown>): Container {
  const number = text(record, 'containerNo', 20);
  if (!CONTAINER.test(number)) return invalid('Turkon Line returned a container without its number');
  const rows = record.events;
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return invalid('Turkon Line returned invalid container moves');
  const events: CarrierEvent[] = [], planned: PlannedEvent[] = [];
  let sailed = false;
  for (const row of rows) {
    if (!isRecord(row)) return invalid('Turkon Line returned an invalid container move');
    const owner = text(row, 'containerNo', 20);
    if (owner && owner !== number) return invalid('Turkon Line returned another container\'s move');
    const code = text(row, 'eventCode', 10), description = text(row, 'eventName', 200), location = text(row, 'eventLokasyon', 200);
    if (!CODE.test(code) || !description) return invalid('Turkon Line returned a move without its name');
    const day = dayOf(text(row, 'eventTarih', 20)), time = text(row, 'eventSaat', 20);
    if (time && !TIME.test(time)) return invalid('Turkon Line returned an invalid move time');
    let stage = turkonStage(code);
    if (text(row, 'ekVeri3', 5) === PLANNED || !time) {
      planned.push({ local_time: day, description, ...(location ? { location } : {}), ...(stage ? { stage } : {}) });
      continue;
    }
    // A container gated in full after it sailed is moving on; one returned empty before it sailed was never used.
    if (sailed && code === 'GIF') stage = 'in_transit';
    if (!sailed && code === 'GIE') stage = undefined;
    if (SAILED.has(code)) sailed = true;
    events.push({ local_time: `${day}T${time}`, description, ...(location ? { location } : {}), provider_code: code,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }
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

/**
 * The containers' moves the tracking page asks for: each container of a booking, or a
 * container's latest booking, with its moves done and due. A number Turkon does not hold has none.
 */
export function parseTurkon(body: string, query: TurkonQuery): CarrierResult {
  let reply: unknown;
  try { reply = JSON.parse(body); } catch (cause) { throw new SchemaError(PROVIDER, 'Turkon Line returned a reply that is not JSON', { cause }); }
  if (!isRecord(reply)) return invalid('Turkon Line returned an invalid reply');
  if (reply.hasError === true) throw new TransportError(PROVIDER, 'Turkon Line reported an error');
  if (!Array.isArray(reply.payload) || reply.payload.length > MAX_CONTAINERS || !reply.payload.every(isRecord)) {
    return invalid('Turkon Line returned an invalid reply');
  }
  if (!reply.payload.length) throw new NotFoundError(PROVIDER, 'Turkon Line does not hold this number');
  const records = reply.payload as Record<string, unknown>[];
  const bookings = new Set(records.map(record => withoutZeros(text(record, 'bookingNo', 30))));
  if (bookings.has('')) return invalid('Turkon Line returned a container without its booking');
  let containers = records.map(container);
  if (query.kind === 'container') {
    containers = containers.filter(item => item.number === query.number);
    if (!containers.length) throw new IndeterminateError(PROVIDER, 'Turkon Line answered for another container');
  } else if (bookings.size !== 1 || !bookings.has(withoutZeros(query.number))) {
    throw new IndeterminateError(PROVIDER, 'Turkon Line answered for another booking');
  }

  const seen = new Set<string>();
  const events = containers.flatMap((item, index) => item.events.map((event, row) => ({ event, order: index * MAX_ROWS + row })))
    .sort(newestFirst)
    // A booking's containers share their vessel's moves: each is kept once.
    .filter(({ event }) => {
      const key = JSON.stringify([event.local_time, event.provider_code, event.location ?? '']);
      return !seen.has(key) && Boolean(seen.add(key));
    })
    .map(({ event }) => event);
  const planned = containers.flatMap(item => item.planned);
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Turkon Line lists the shipment without moves', { reason: 'listed' });
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
