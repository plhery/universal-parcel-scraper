import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { canadaProvinceTimeZone, countryTimeZone, isoTime, usStateTimeZone } from '../../core/time/index.js';
import { wanHaiStage } from './status.js';

export const PROVIDER = 'Wan Hai';
/** The cargo tracking service of Wan Hai's app, answered with JSON. */
export const WAN_HAI_API = 'https://whlapiv2.wanhai.com/shipping/rest/eshipping/skd/cargo-tracking';
export const WAN_HAI_MAX_BYTES = 2_000_000;
/** The containers of a bill whose own moves are asked; the others keep their latest event. */
export const MAX_DETAILS = 3;

const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
// Wan Hai's bookings and bills are three digits for the office, a letter, a letter or digit and
// five digits. Import records put Wan Hai's SCAC, WHLC, before them; the app takes them without it.
const BILL = /^(?:WHLC)?(\d{3}[A-Z][A-Z\d]\d{5})$/;
const MAX_ROWS = 500;

/** What Wan Hai's app tracks: a booking or bill of lading, or a container by its ISO 6346 number. */
export type WanHaiQuery = { kind: 'bill' | 'container'; number: string };

// Letters count from 10 and skip the multiples of 11: A is 10, B 12, L 23, Z 38.
const LETTER_VALUES = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter, index) => [letter, 10 + index + Math.floor((index + 9) / 10)]));

/** The ISO 6346 check digit of a container's owner code, category and serial number. */
export function containerCheckDigit(body: string): number {
  if (!/^[A-Z]{3}[UJZ]\d{6}$/.test(body)) throw new InvalidInputError(PROVIDER, 'Container numbers are an owner code, a category letter and six digits');
  const sum = [...body].reduce((total, character, index) => total + (LETTER_VALUES.get(character) ?? Number(character)) * 2 ** index, 0);
  return sum % 11 % 10;
}

/** A whole container number with its check digit, or a booking or bill with or without WHLC. */
export function wanHaiQuery(raw: string): WanHaiQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (CONTAINER.test(number)) {
    if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
    return { kind: 'container', number };
  }
  const bill = BILL.exec(number)?.[1];
  if (bill) return { kind: 'bill', number: bill };
  throw new InvalidInputError(PROVIDER, 'Wan Hai tracks a booking or bill of lading of ten characters or a container number');
}

/** The app's request for one of its cargo tracking screens. */
export const wanHaiUrl = (screen: 'bl-detail' | 'booking-detail' | 'ctnr-no' | 'movement', params: Record<string, string>) =>
  `${WAN_HAI_API}/${screen}?${new URLSearchParams(params)}`;

type Row = Record<string, unknown>;
const isRecord = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(row: Row, key: string, max = 300): string {
  const value = row[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw new SchemaError(PROVIDER, `Wan Hai returned an invalid ${key}`);
  return value.replace(/\s+/g, ' ').trim();
}

function list(row: Row, key: string, max = MAX_ROWS): Row[] {
  const value = row[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max || !value.every(isRecord)) throw new SchemaError(PROVIDER, `Wan Hai returned an invalid ${key}`);
  return value;
}

/** A reply's result, once its status says the request succeeded. */
function result(reply: unknown, title: string): Row {
  if (!isRecord(reply) || !isRecord(reply.result)) throw new SchemaError(PROVIDER, 'Wan Hai returned a reply without a result');
  if (reply.status !== '0000') throw new SchemaError(PROVIDER, 'Wan Hai refused the request');
  if (text(reply.result, 'title', 40) !== title) throw new SchemaError(PROVIDER, 'Wan Hai returned another number');
  return reply.result;
}

// A place of the route with its date: its town, its state or province, and its country.
const ROUTE_PLACE = /^(.+?)(?:,\s*([A-Z]{2}))?\s*\(([A-Z]{2})\)\s*-\s*\d{4}\/\d{2}\/\d{2}$/;
const ROUTE_KEY = /^(?:Place of Receipt|Port of Loading|T\/S Port|Port of Discharging|Place of Delivery)\b/;

/** A name's words, lowercased without accents or punctuation. */
const words = (name: string) => name.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The zones of the route's towns by their words: a US state's or Canadian province's by the code
 * after the town, another country's when it keeps one.
 */
function routeZones(result: Row): Map<string, string> {
  const zones = new Map<string, string>();
  for (const row of list(result, 'basic_list', 50)) {
    if (!ROUTE_KEY.test(text(row, 'key'))) continue;
    const place = ROUTE_PLACE.exec(text(row, 'value'));
    if (!place) continue;
    const [, town, region, country] = place;
    const zone = country === 'US' ? usStateTimeZone(region) : country === 'CA' ? canadaProvinceTimeZone(region) : countryTimeZone(country);
    if (zone && words(town!)) zones.set(words(town!), zone);
  }
  return zones;
}

/** The zone of the route town a facility's name contains, when it contains one town's only. */
function facilityZone(facility: string, zones: ReadonlyMap<string, string>): string | undefined {
  const name = ` ${words(facility)} `;
  const found = new Set([...zones].filter(([town]) => name.includes(` ${town} `)).map(([, zone]) => zone));
  return found.size === 1 ? [...found][0] : undefined;
}

const MOVE_DATE = /^(\d{4})\/(\d{2})\/(\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/;

/** An event's wall clock, and the instant it gives in its facility's zone when the route names its town. */
function stamp(date: string, facility: string, zones: ReadonlyMap<string, string>) {
  const parts = MOVE_DATE.exec(date);
  const local = parts ? `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:00` : '';
  const year = Number(parts?.[1]);
  if (!parts || year < 2001 || year > 2100 || !isoTime(local, 'UTC')) throw new SchemaError(PROVIDER, 'Wan Hai returned an invalid event time');
  const zone = facilityZone(facility, zones);
  const time = zone ? isoTime(local, zone) : null;
  return time ? { local_time: local, time: time.iso, time_zone: zone!, time_zone_basis: 'place' } : { local_time: local };
}

type Move = CarrierEvent & { local_time: string };

function move(description: string, date: string, facility: string, zones: ReadonlyMap<string, string>): Move {
  if (!description) throw new SchemaError(PROVIDER, 'Wan Hai returned an event without wording');
  const stage = wanHaiStage(description);
  return { ...stamp(date, facility, zones), ...(facility ? { location: facility } : {}), description,
    ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}) };
}

const newestFirst = (left: Move, right: Move) => right.local_time.localeCompare(left.local_time);

// The stages of a container that has not moved yet.
const BEFORE_MOVING: ReadonlySet<string> = new Set<Stage>(['pending', 'registered', 'accepted']);

/**
 * A container's moves newest first, as the reply lists them. A gate in after the container moved
 * is transit; an empty container returned before it moved was not used, which is no delivery.
 * A container known by its latest event alone has moved.
 */
function containerHistory(moves: Move[], complete: boolean): Move[] {
  const events = [...moves].sort(newestFirst);
  let moved = !complete;
  for (const event of [...events].reverse()) {
    if (event.stage === 'delivered' && !moved) {
      delete (event as CarrierEvent).stage;
      delete (event as CarrierEvent).stage_source;
    } else if (moved && event.stage && BEFORE_MOVING.has(event.stage)) {
      event.stage = 'in_transit';
    }
    if (event.stage && !BEFORE_MOVING.has(event.stage)) moved = true;
  }
  return events;
}

/** A booking or bill: the zones of its route, and its containers with their latest events. */
export type WanHaiShipment = { refNo: string; zones: Map<string, string>; containers: { number: string; latest: Move | null }[] };

/**
 * A bill's or booking's containers from the app's B/L or booking screen, or none when Wan Hai
 * lists none for the number. The B/L screen gives each container's current status; the booking
 * screen, before the bill is issued, gives none.
 */
export function wanHaiShipment(reply: unknown, refNo: string): WanHaiShipment | null {
  const found = result(reply, refNo);
  const zones = routeZones(found);
  const seen = new Set<string>();
  const containers = list(found, 'container_list').map(row => {
    const number = text(row, 'ctnr_no', 20);
    if (!CONTAINER.test(number) || seen.has(number)) throw new SchemaError(PROVIDER, 'Wan Hai returned an invalid container');
    seen.add(number);
    const status = text(row, 'current_status');
    return { number, latest: status ? move(status, text(row, 'status_date', 20), '', zones) : null };
  });
  if (!containers.length) {
    if (list(found, 'basic_list', 50).length) throw new NoHistoryError(PROVIDER, 'Wan Hai lists the shipment without containers', { reason: 'listed' });
    return null;
  }
  return { refNo, zones, containers };
}

/** The booking a container's latest cycle belongs to, from the app's container screen, or none. */
export function wanHaiContainerRef(reply: unknown, container: string): string | null {
  const found = result(reply, container);
  const refNo = text(found, 'ref_no', 20);
  if (!refNo) {
    if (list(found, 'information_list', 50).length) throw new SchemaError(PROVIDER, 'Wan Hai returned a container without its booking');
    return null;
  }
  if (!/^[A-Z\d]{10}$/.test(refNo)) throw new SchemaError(PROVIDER, 'Wan Hai returned an invalid booking');
  return refNo;
}

/** A container's moves under a booking, from the app's movement screen. */
export function wanHaiMoves(reply: unknown, container: string, zones: ReadonlyMap<string, string>): Move[] {
  return list(result(reply, container), 'movement_list').map(row =>
    move(text(row, 'status_name'), text(row, 'ctnr_date', 20), text(row, 'depot_name'), zones));
}

/**
 * The stage the shipment is at. A bill's containers move apart: one returned empty does not
 * make the others delivered, so a delivery decides only once every container has one, and a
 * container without a staged event leaves the stage open.
 */
function currentStage(histories: readonly Move[][]): Stage | undefined {
  const latest = histories.map(events => events.find(event => event.stage)).filter((event): event is Move => event !== undefined);
  const open = latest.filter(event => event.stage !== 'delivered').sort(newestFirst)[0];
  if (open) return open.stage as Stage;
  return latest.length && latest.length === histories.length ? 'delivered' : undefined;
}

/**
 * The shipment from its containers: each one's moves, or its latest event where they were not
 * asked, merged newest first and those the containers share kept once.
 */
export function wanHaiResult(shipment: WanHaiShipment | null, details: ReadonlyMap<string, readonly Move[]> = new Map()): CarrierResult {
  if (!shipment) throw new NotFoundError(PROVIDER, 'Wan Hai does not hold this number');
  let truncated = false;
  const histories = shipment.containers.map(container => {
    const moves = details.get(container.number);
    if (moves) return containerHistory([...moves], true);
    truncated ||= container.latest !== null;
    return container.latest ? containerHistory([container.latest], false) : [];
  });
  const seen = new Set<string>();
  const events = histories.flat().sort(newestFirst).filter(event => {
    const key = JSON.stringify([event.local_time, event.description, event.location ?? '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Wan Hai lists the shipment without moves', { reason: 'listed' });
  const newest = events[0]!;
  const stage = currentStage(histories);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description ?? null,
    last_update: newest.time ?? null, ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: null, ...(truncated || events.length > MAX_ROWS ? { history_truncated: true } : {}), events: events.slice(0, MAX_ROWS),
  };
}

const REFUSED = /_Incapsula_Resource|Incapsula incident|<title>\s*Access Denied\s*<\/title>/i;

/** A reply's JSON, or the error a page in its place stands for. */
export function wanHaiJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch {
    if (REFUSED.test(body)) throw new ChallengeError(PROVIDER, 'Imperva refused Wan Hai\'s tracking request');
    throw new SchemaError(PROVIDER, 'Wan Hai returned a reply that is not JSON');
  }
}
