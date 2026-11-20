import { DateTime, FixedOffsetZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { plannedEvents, type PlannedEvent } from '../../core/result/planned.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { oneNamedStage, oneStage } from './status.js';

export const PROVIDER = 'Ocean Network Express';
/** The site whose cargo tracking page asks the API below. */
export const ONE_ORIGIN = 'https://www.one-line.com';
const API = 'https://ecomm.one-line.com/api/v2/edh/containers/track-and-trace';
/** Turns a booking number into the one to search, or none for a booking ONE does not hold. */
export const ONE_VALIDATE = `${API}/validate-booking`;
/** A booking's containers, or a container's latest booking, with a summary of each. */
export const ONE_SEARCH = `${API}/search`;
/** A container's events within a booking. */
export const oneEventsUrl = (booking: string, container: string) =>
  `${API}/cop-events?${new URLSearchParams({ booking_no: booking, container_no: container })}`;
export const ONE_REPLY_MAX_BYTES = 2 * 1024 * 1024;
/** The containers one search returns: ONE's bookings rarely hold more. */
export const PAGE_LENGTH = 100;
/** The containers whose events are asked for. Beyond them, the history is cut short. */
export const MAX_CONTAINER_LOOKUPS = 20;

const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)|captcha-delivery\.com|verify (?:that )?you are human/i;
const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
// The page takes a booking of twelve or thirteen characters with at least four letters.
const BOOKING = /^(?=(?:[0-9]*[A-Z]){4})(?=[A-Z]*[0-9])[A-Z0-9]{12,13}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 200;
// Fall 2001 to 2100: a date outside is no scan's.
const EARLIEST = 1_000_000_000_000;
const LATEST = 4_102_444_800_000;

/** What ONE's page searches: a container by its ISO 6346 number, or a booking, also as the bill of lading `ONEY` and the booking. */
export type OneQuery =
  | { kind: 'container'; number: string }
  | { kind: 'booking'; number: string; booking: string };

// Letters count from 10 and skip the multiples of 11: A is 10, B 12, L 23, Z 38.
const LETTER_VALUES = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter, index) => [letter, 10 + index + Math.floor((index + 9) / 10)]));

/** The ISO 6346 check digit of a container's owner code, category and serial number. */
export function containerCheckDigit(body: string): number {
  if (!/^[A-Z]{3}[UJZ]\d{6}$/.test(body)) throw new InvalidInputError(PROVIDER, 'Container numbers are an owner code, a category letter and six digits');
  const sum = [...body].reduce((total, character, index) => total + (LETTER_VALUES.get(character) ?? Number(character)) * 2 ** index, 0);
  return sum % 11 % 10;
}

/** The query for a number ONE's page takes: a whole container number with its check digit, a booking, or `ONEY` and a booking. */
export function oneQuery(raw: string): OneQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (CONTAINER.test(number)) {
    if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
    return { kind: 'container', number };
  }
  // ONE's bill of lading is its carrier code and the booking; the page asks for the booking alone.
  const booking = /^ONEY[A-Z0-9]{12,13}$/.test(number) ? number.slice(4) : number;
  if (BOOKING.test(booking)) return { kind: 'booking', number, booking };
  throw new InvalidInputError(PROVIDER, 'ONE tracks a container number, a booking number or an ONEY bill of lading');
}

/** A reply ONE's API, rather than a challenge, answered, with its envelope checked. */
function envelope(body: string): Record<string, unknown> {
  if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ONE requires browser verification');
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'ONE returned a reply that is not JSON', { cause });
  }
  if (!isRecord(reply) || reply.status !== 200 || reply.code !== 1) throw new SchemaError(PROVIDER, 'ONE returned an error');
  return reply;
}

const text = (record: Record<string, unknown>, key: string, maxLength = 200): string => {
  const value = record[key];
  if (value !== null && value !== undefined && typeof value !== 'string') throw new SchemaError(PROVIDER, `ONE returned an invalid ${key}`);
  return clean(value, maxLength);
};
const recordOf = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = record[key];
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) throw new SchemaError(PROVIDER, `ONE returned an invalid ${key}`);
  return value;
};
const rowsOf = (record: Record<string, unknown>, key: string): Record<string, unknown>[] => {
  const value = record[key];
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ROWS || !value.every(isRecord)) throw new SchemaError(PROVIDER, `ONE returned an invalid ${key}`);
  return value;
};

/**
 * The booking ONE searches for the one asked, from its answer to the page's check. A booking
 * it moved to its earlier tracker comes back among `bkgBefore`, which the page shows with a link
 * there; a booking it does not hold, nowhere.
 */
export function validatedBooking(body: string, booking: string): string {
  const data = recordOf(envelope(body), 'data');
  const after = text(data, 'bkgAfter', 100);
  if (!after) {
    if (text(data, 'bkgBefore', 2000).split(',').map(item => item.trim()).includes(booking)) {
      throw new IndeterminateError(PROVIDER, 'ONE keeps this booking in its earlier tracker');
    }
    throw new NotFoundError(PROVIDER, 'ONE does not hold this booking');
  }
  if (!BOOKING.test(after)) throw new SchemaError(PROVIDER, 'ONE returned an invalid booking');
  return after;
}

/** A container of the search reply: its booking, its number, and the name and wall clock of its latest event. */
export interface OneContainer {
  readonly booking: string;
  readonly container: string;
  readonly latest: string;
  readonly latestDate: string;
}

export interface OneSearch {
  readonly containers: readonly OneContainer[];
  /** More containers than the reply lists. */
  readonly more: boolean;
}

/**
 * ONE's search reply: the booking's containers, or the bookings a container served. A container's
 * lookup keeps its latest booking, as the other bookings are other shipments. Its envelope alone
 * means nothing matched.
 */
export function oneSearch(body: string, query: OneQuery, booking?: string): OneSearch {
  const reply = envelope(body);
  const rows = rowsOf(reply, 'data');
  if (rows.length > PAGE_LENGTH) throw new SchemaError(PROVIDER, 'ONE returned more containers than it was asked for');
  const total = reply.total;
  if (total !== undefined && (typeof total !== 'number' || !Number.isInteger(total) || total < rows.length)) throw new SchemaError(PROVIDER, 'ONE returned an invalid total');
  const containers = rows.map((row): OneContainer => {
    const container: OneContainer = { booking: text(row, 'bookingNo', 20), container: text(row, 'containerNo', 20),
      latest: text(recordOf(row, 'latestEvent'), 'eventName', 300), latestDate: text(recordOf(row, 'latestEvent'), 'date', 40) };
    if (!BOOKING.test(container.booking) || container.container && !CONTAINER.test(container.container)) throw new SchemaError(PROVIDER, 'ONE returned a container without its numbers');
    return container;
  });
  if (query.kind === 'booking') {
    if (containers.some(item => item.booking !== booking)) throw new SchemaError(PROVIDER, 'ONE returned another booking');
    return { containers, more: (typeof total === 'number' ? total : rows.length) > rows.length };
  }
  if (!containers.length) throw new NotFoundError(PROVIDER, 'ONE does not hold this container');
  const matching = containers.filter(item => item.container === query.number);
  if (!matching.length) throw new SchemaError(PROVIDER, 'ONE returned another container');
  return { containers: [matching.reduce((latest, item) => item.latestDate > latest.latestDate ? item : latest)], more: false };
}

/**
 * The instant of an event: ONE gives its place's wall clock labelled as UTC and, apart, the
 * instant in UTC. Their difference is the place's offset, which the instant keeps.
 */
function instant(local: unknown, utc: unknown): string | undefined {
  if (utc === '' || utc === null || utc === undefined) return undefined;
  const at = typeof utc === 'string' && utc.length <= 40 ? DateTime.fromISO(utc, { zone: 'utc' }) : null;
  if (!at?.isValid || at.toMillis() < EARLIEST || at.toMillis() > LATEST) throw new SchemaError(PROVIDER, 'ONE returned an invalid date');
  const wall = typeof local === 'string' && local && local.length <= 40 ? DateTime.fromISO(local, { zone: 'utc' }) : null;
  const offset = wall?.isValid ? Math.round((wall.toMillis() - at.toMillis()) / 60_000) : NaN;
  const zone = Number.isInteger(offset) && Math.abs(offset) <= 14 * 60 && offset % 15 === 0 ? FixedOffsetZone.instance(offset) : FixedOffsetZone.utcInstance;
  return at.setZone(zone).toISO({ suppressMilliseconds: true })!;
}

/** A place as ONE names it: the yard, then the town and its country unless the town is the country. */
function place(town: string, country: string, yard = ''): string | undefined {
  const parts = [yard, town, country && country !== town ? country : ''].filter(Boolean);
  return parts.length ? parts.join(', ') : undefined;
}

export interface OneEvents {
  readonly events: readonly CarrierEvent[];
  readonly planned: readonly PlannedEvent[];
}

// The stages of a container that has not moved yet.
const BEFORE_MOVING: ReadonlySet<string> = new Set<Stage>(['pending', 'registered', 'accepted']);

/**
 * A container's events, newest first. ONE lists its moves in their order along the route; a
 * move it has not dated cannot be placed among the others and is left out, and an estimated one
 * is a planned step. A gate in at the port after the container moved inland is transit.
 */
export function containerEvents(body: string): OneEvents {
  const rows = rowsOf(envelope(body), 'data');
  const dated: { event: CarrierEvent; sequence: number; at: number }[] = [];
  const planned: CarrierEvent[] = [];
  for (const row of rows) {
    const code = text(row, 'matrixId', 20);
    const description = text(row, 'eventName', 300);
    if (!/^[A-Z]\d{3}(?:-\d{1,2})?$/.test(code) || !description) throw new SchemaError(PROVIDER, 'ONE returned an event without its name');
    const time = instant(row.eventLocalPortDate, row.eventDate);
    const trigger = text(row, 'triggerType', 20);
    if (!time || trigger !== 'ACTUAL' && trigger !== 'ESTIMATED') continue;
    const location = recordOf(row, 'location');
    const where = place(text(location, 'locationName'), text(location, 'countryName'), text(recordOf(row, 'yard'), 'yardName'));
    const stage = oneStage(code);
    const event: CarrierEvent = { time, ...(where ? { location: where } : {}), description, provider_code: code,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    if (trigger === 'ESTIMATED') planned.push(event);
    else dated.push({ event, sequence: typeof row.copSequence === 'number' ? row.copSequence : 0, at: Date.parse(time) });
  }
  const events = dated.sort((left, right) => right.at - left.at || right.sequence - left.sequence).map(({ event }) => event);
  let moved = false;
  for (const event of [...events].reverse()) {
    if (moved && event.stage && BEFORE_MOVING.has(event.stage)) event.stage = 'in_transit';
    if (event.stage && !BEFORE_MOVING.has(event.stage)) moved = true;
  }
  return { events, planned: plannedEvents(planned) };
}

const newestFirst = (left: CarrierEvent, right: CarrierEvent) => Date.parse(right.time!) - Date.parse(left.time!);

/**
 * The stage the shipment is at. A booking's containers move apart: one returned empty from the
 * consignee does not make the others delivered, so a delivery decides only once every container
 * has one. A container whose events were not asked for counts by its latest event's name.
 */
function currentStage(read: readonly OneEvents[], unread: readonly OneContainer[]): Stage | undefined {
  const latest = read.map(item => item.events.find(event => event.stage)).filter((event): event is CarrierEvent => event !== undefined);
  const open = latest.filter(event => event.stage !== 'delivered').sort(newestFirst)[0];
  if (open) return open.stage as Stage;
  const waiting = unread.map(item => oneNamedStage(item.latest));
  if (waiting.some(stage => stage !== 'delivered')) return waiting.find((stage): stage is Stage => stage !== undefined && stage !== 'delivered');
  return latest.length ? 'delivered' : undefined;
}

/**
 * A booking's or container's history from the search reply and each container's events: their
 * events merged newest first with the moves they share kept once, and the steps ONE estimates
 * kept as planned.
 */
export function oneResult(search: OneSearch, read: readonly OneEvents[]): CarrierResult {
  const unread = search.containers.filter(item => item.container).slice(read.length);
  const seen = new Set<string>();
  const events = read.flatMap(item => item.events).sort(newestFirst).filter(event => {
    const key = JSON.stringify([event.time, event.location ?? '', event.description]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const planned = plannedEvents(read.flatMap(item => item.planned));
  if (!events.length) {
    throw new NoHistoryError(PROVIDER, 'ONE lists the shipment without events', { reason: 'listed', ...(planned.length ? { plannedEvents: planned } : {}) });
  }
  const newest = events[0]!;
  const stage = currentStage(read, unread);
  const truncated = search.more || unread.length > 0 || events.length > MAX_EVENTS;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: newest.time ?? null, expected_delivery: null,
    ...(truncated ? { history_truncated: true } : {}), events: events.slice(0, MAX_EVENTS),
    ...(planned.length ? { planned_events: planned } : {}),
  };
}
