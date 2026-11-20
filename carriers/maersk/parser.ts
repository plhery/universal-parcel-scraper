import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { plannedEvents } from '../../core/result/planned.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, countryTimeZone, isoTime, usStateTimeZone } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { maerskStage } from './status.js';

export const PROVIDER = 'Maersk';
/** The tracking page, which opens one bill, booking or container from its path. */
export const MAERSK_PAGE = 'https://www.maersk.com/tracking/';
export const MAERSK_API_ORIGIN = 'https://api.maersk.com';
/** The lookup the page makes for one number, for Maersk's own carrier code. */
export const MAERSK_LOOKUP_PATH = '/synergy/tracking/';
export const MAERSK_OPERATOR = 'MAEU';
export const MAERSK_MAX_BYTES = 2_000_000;

const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
// The page takes a bill of lading or booking of nine characters; import records put MAEU, the carrier code, before it.
const DOCUMENT = /^(?:MAEU)?((?=[A-Z]*\d)[A-Z0-9]{9})$/;
const LOCAL_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?$/;
const MAX_CONTAINERS = 200;
const MAX_ROWS = 500;
const MAX_EVENTS = 200;
const EARLIEST_YEAR = 2001;
const LATEST_YEAR = 2100;

/** What Maersk's page tracks: a container by its ISO 6346 number, or a bill of lading or booking. */
export type MaerskQuery = { kind: 'container' | 'document'; number: string };

// Letters count from 10 and skip the multiples of 11: A is 10, B 12, L 23, Z 38.
const LETTER_VALUES = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter, index) => [letter, 10 + index + Math.floor((index + 9) / 10)]));

/** The ISO 6346 check digit of a container's owner code, category and serial number. */
export function containerCheckDigit(body: string): number {
  if (!/^[A-Z]{3}[UJZ]\d{6}$/.test(body)) throw new InvalidInputError(PROVIDER, 'Container numbers are an owner code, a category letter and six digits');
  const sum = [...body].reduce((total, character, index) => total + (LETTER_VALUES.get(character) ?? Number(character)) * 2 ** index, 0);
  return sum % 11 % 10;
}

/** The number Maersk's page looks up: a whole container number with its check digit, or a bill of lading or booking without `MAEU`. */
export function maerskQuery(raw: string): MaerskQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (CONTAINER.test(number)) {
    if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
    return { kind: 'container', number };
  }
  const document = DOCUMENT.exec(number)?.[1];
  if (document) return { kind: 'document', number: document };
  throw new InvalidInputError(PROVIDER, 'Maersk tracks a container number or a bill of lading or booking of nine characters');
}

export const maerskPageUrl = (query: MaerskQuery) => `${MAERSK_PAGE}${query.number}`;
export const maerskLookupUrl = (query: MaerskQuery) =>
  `${MAERSK_API_ORIGIN}${MAERSK_LOOKUP_PATH}${query.number}?${new URLSearchParams({ operator: MAERSK_OPERATOR })}`;

const text = (record: Record<string, unknown>, key: string, maxLength = 200): string => {
  const value = record[key];
  if (value !== null && value !== undefined && typeof value !== 'string') throw new SchemaError(PROVIDER, `Maersk returned an invalid ${key}`);
  return clean(value, maxLength);
};
const rowsOf = (record: Record<string, unknown>, key: string, max = MAX_ROWS): Record<string, unknown>[] => {
  const value = record[key];
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || !value.every(isRecord)) throw new SchemaError(PROVIDER, `Maersk returned an invalid ${key}`);
  return value;
};

/**
 * Maersk's answer for a number it does not hold: a 404 whose JSON names the number. Any other
 * 404 is no answer about the number.
 */
export function notHeld(body: string, query: MaerskQuery): NotFoundError | null {
  let reply: unknown;
  try { reply = JSON.parse(body); } catch { return null; }
  if (!isRecord(reply) || reply.status !== 404 || typeof reply.message !== 'string') return null;
  return reply.message === `No tracking data found for: ${query.number}` && reply.requestUri === `${MAERSK_LOOKUP_PATH}${query.number}`
    ? new NotFoundError(PROVIDER, query.kind === 'container' ? 'Maersk does not hold this container' : 'Maersk does not hold this bill of lading or booking')
    : null;
}

// The activities the page shows, the others it leaves out.
const SHOWN = new Set(['GATE-OUT', 'GATE-IN', 'CONTAINER DEPARTURE', 'CONTAINER ARRIVAL', 'CUSTOMER_GATE_IN', 'CUSTOMER_GATE_OUT', 'ON-RAIL',
  'OFF-RAIL', 'ARRIVECU', 'DEPARTCU', 'CONTAINER RETURN', 'LOAD', 'DISCHARG', 'RAIL_DEPARTURE', 'RAIL_ARRIVAL_AT_DESTINATION', 'STRIPPIN', 'STUFFING']);

/** The page's label for an activity: a gate move of an empty container, and a full one leaving for delivery, are labels of their own. */
export function activityCode(activity: string, empty: boolean, leg: string): string {
  const label = ['GATE-OUT', 'GATE-IN', 'CUSTOMER_GATE_OUT', 'CUSTOMER_GATE_IN'].includes(activity) && empty ? `${activity}-EMPTY`
    : activity === 'GATE-OUT' && leg === 'DEL' ? 'GATE-OUT-DELIVERY' : activity;
  return label.replace(/[ _]/g, '-');
}

/** The means of transport the page names a departure or arrival by. */
function conveyance(mode: string): string {
  if (mode === 'FEF' || mode === 'FEO') return 'Feeder';
  if (mode === 'BAR' || mode === 'BCO') return 'Barge';
  if (mode === 'RCO' || mode === 'RR') return 'Rail';
  if (mode === 'TRK') return 'Truck';
  return 'Vessel';
}

// The page's English wording for each label.
const WORDING: Readonly<Record<string, string>> = {
  'GATE-OUT-EMPTY': 'Gate out Empty', 'GATE-IN-EMPTY': 'Gate in Empty', 'GATE-OUT-DELIVERY': 'Gate out for delivery', 'GATE-OUT': 'Gate out',
  'GATE-IN': 'Gate in', LOAD: 'Load', DISCHARG: 'Discharge', 'CONTAINER-RETURN': 'Empty container return', 'ON-RAIL': 'On rail',
  'OFF-RAIL': 'Off rail', 'RAIL-DEPARTURE': 'Rail departure', 'RAIL-ARRIVAL-AT-DESTINATION': 'Rail arrival',
  'CUSTOMER-GATE-IN': 'Gate in (customer facility)', 'CUSTOMER-GATE-IN-EMPTY': 'Gate in empty (customer facility)',
  'CUSTOMER-GATE-OUT': 'Gate out (customer facility)', 'CUSTOMER-GATE-OUT-EMPTY': 'Gate out empty (customer facility)',
  ARRIVECU: 'Arrival at customer site', DEPARTCU: 'Departure from customer site', STRIPPIN: 'Container unpacking', STUFFING: 'Container packing',
};

function describe(code: string, mode: string): string {
  if (code === 'CONTAINER-DEPARTURE') return `${conveyance(mode)} departure`;
  if (code === 'CONTAINER-ARRIVAL') return `${conveyance(mode)} arrival`;
  return WORDING[code] ?? code;
}

/** A place of the reply: its town, its country and, in the United States, its state. */
interface Place { readonly name?: string; readonly zone: string | null }

/**
 * A location as the page shows it, the terminal or depot, the town and the country, and the zone
 * of its clock: its country's when the country keeps one, a US state's by the state's code. A
 * country whose code a state shares, as Puerto Rico's, has its zone by its name.
 */
function placeOf(location: Record<string, unknown>): Place {
  const country = countryCode(text(location, 'country_code', 4));
  const name = text(location, 'country');
  const parts = [text(location, 'terminal'), text(location, 'city'), name].filter(Boolean);
  const zone = country === 'US' ? usStateTimeZone(text(location, 'state', 60))
    : country ? countryTimeZone(country) ?? (countryCode(name) === country ? countryTimeZone(name) : null) : null;
  return { ...(parts.length ? { name: parts.join(', ') } : {}), zone };
}

/** An event's wall clock, the place's local time the page shows, and the instant it gives in the place's zone. */
function stamp(value: string, place: Place): Pick<CarrierEvent, 'time' | 'local_time' | 'time_zone' | 'time_zone_basis'> {
  const local = LOCAL_TIME.exec(value)?.[1];
  const year = Number(local?.slice(0, 4));
  if (!local || year < EARLIEST_YEAR || year > LATEST_YEAR || !isoTime(local, 'UTC')) {
    throw new SchemaError(PROVIDER, 'Maersk returned an invalid event time');
  }
  const time = place.zone ? isoTime(local, place.zone) : null;
  return time ? { local_time: local, time: time.iso, time_zone: place.zone!, time_zone_basis: 'place' } : { local_time: local };
}

const order = (event: CarrierEvent) => event.time ? Date.parse(event.time) : Date.parse(`${event.local_time}Z`);
const newestFirst = (left: CarrierEvent, right: CarrierEvent) => order(right) - order(left);

// The stages of a container that has not moved yet.
const BEFORE_MOVING: ReadonlySet<string> = new Set<Stage>(['pending', 'registered', 'accepted']);

interface ContainerHistory { readonly events: CarrierEvent[]; readonly planned: CarrierEvent[] }

/**
 * A container's events, newest first, each on its place's wall clock. An expected one is a
 * planned step. A gate in after the container moved, at a port it reaches by rail for instance,
 * is transit.
 */
function containerHistory(container: Record<string, unknown>): ContainerHistory {
  const events: CarrierEvent[] = [];
  const planned: CarrierEvent[] = [];
  for (const location of rowsOf(container, 'locations')) {
    const place = placeOf(location);
    for (const row of rowsOf(location, 'events')) {
      const activity = text(row, 'activity', 60);
      if (!SHOWN.has(activity)) continue;
      const timing = text(row, 'event_time_type', 20);
      if (timing !== 'ACTUAL' && timing !== 'EXPECTED') continue;
      if (typeof row.stempty !== 'boolean' && row.stempty !== undefined) throw new SchemaError(PROVIDER, 'Maersk returned an invalid stempty');
      const code = activityCode(activity, row.stempty === true, text(row, 'actfor', 10));
      const stage = maerskStage(code);
      const event: CarrierEvent = { ...stamp(text(row, 'event_time', 40), place), ...(place.name ? { location: place.name } : {}),
        description: describe(code, text(row, 'transport_mode', 10)), provider_code: code, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
      (timing === 'EXPECTED' ? planned : events).push(event);
    }
  }
  events.sort(newestFirst);
  let moved = false;
  for (const event of [...events].reverse()) {
    if (moved && event.stage && BEFORE_MOVING.has(event.stage)) event.stage = 'in_transit';
    if (event.stage && !BEFORE_MOVING.has(event.stage)) moved = true;
  }
  return { events, planned };
}

/**
 * The stage the shipment is at. A bill's containers move apart: one returned empty does not
 * make the others delivered, so a delivery decides only once every container has one, and a
 * container without a staged event leaves the stage open.
 */
function currentStage(histories: readonly ContainerHistory[]): Stage | undefined {
  const latest = histories.map(item => item.events.find(event => event.stage)).filter((event): event is CarrierEvent => event !== undefined);
  const open = latest.filter(event => event.stage !== 'delivered').sort(newestFirst)[0];
  if (open) return open.stage as Stage;
  return latest.length && latest.length === histories.length ? 'delivered' : undefined;
}

/**
 * Maersk's reply for a bill of lading, booking or container: each container's events merged
 * newest first, the moves they share kept once. A bill's reply must name the bill; a container's
 * reply is read for that container alone.
 */
export function maerskResult(reply: unknown, query: MaerskQuery): CarrierResult {
  if (!isRecord(reply)) throw new SchemaError(PROVIDER, 'Maersk returned a reply that is not an object');
  if (typeof reply.is_container_search !== 'boolean' || reply.is_container_search !== (query.kind === 'container')) {
    throw new SchemaError(PROVIDER, 'Maersk returned another kind of lookup');
  }
  if (query.kind === 'document' && text(reply, 'tpdoc_num', 40) !== query.number) throw new SchemaError(PROVIDER, 'Maersk returned another bill of lading');
  let containers = rowsOf(reply, 'containers', MAX_CONTAINERS);
  if (query.kind === 'container') {
    containers = containers.filter(container => text(container, 'container_num', 20) === query.number);
    if (!containers.length) throw new SchemaError(PROVIDER, 'Maersk returned another container');
  } else if (containers.some(container => ![query.number, ''].includes(text(container, 'shipment_num', 40)))) {
    throw new SchemaError(PROVIDER, 'Maersk returned a container of another shipment');
  }
  const histories = containers.map(containerHistory);
  const planned = plannedEvents(histories.flatMap(item => item.planned));
  const seen = new Set<string>();
  const events = histories.flatMap(item => item.events).sort(newestFirst).filter(event => {
    const key = JSON.stringify([event.local_time, event.provider_code, event.location ?? '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!events.length) {
    const message = reply.is_cancelled_shipment === true ? 'Maersk lists the shipment as cancelled' : 'Maersk lists the shipment without events';
    throw new NoHistoryError(PROVIDER, message, { reason: 'listed', ...(planned.length ? { plannedEvents: planned } : {}) });
  }
  const newest = events[0]!;
  const stage = currentStage(histories);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description ?? null,
    ...(newest.time ? { last_update: newest.time } : { last_update: null, last_update_local: newest.local_time! }),
    expected_delivery: null, ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}), events: events.slice(0, MAX_EVENTS),
    ...(planned.length ? { planned_events: planned } : {}),
  };
}
