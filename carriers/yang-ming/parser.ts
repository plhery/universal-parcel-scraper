import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { canadaProvinceTimeZone, countryTimeZone, isoTime, townKey, usStateTimeZone } from '../../core/time/index.js';
import { yangMingStage } from './status.js';

export const PROVIDER = 'Yang Ming';
/** The tracking page, whose search asks the lookup below. */
export const YANG_MING_PAGE = 'https://www.yangming.com/en/ebusiness/cargo_tracking';
/** The lookup the page makes, answered with JSON. */
export const YANG_MING_LOOKUP = 'https://www.yangming.com/api/CargoTracking/GetTracking';
/** Whether Yang Ming blocks the caller's address, which the page asks before each search. */
export const YANG_MING_BLOCK_STATUS = 'https://www.yangming.com/api/Public/GetBlockStatus';
export const YANG_MING_MAX_BYTES = 2_000_000;
/** The containers of a bill whose own moves are asked; the others keep their latest event. */
export const MAX_DETAILS = 3;

const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
// Yang Ming's bills are a letter and nine digits. Import records put a SCAC of Yang Ming's before
// them, YMJA most often; the lookup takes the bill without it.
const BILL = /^(?:YMJA|YMLU|YMPR|YMSG)?([A-Z]\d{9})$/;
const MAX_ROWS = 500;

/** What Yang Ming's page tracks: a bill of lading, or a container by its ISO 6346 number. */
export type YangMingQuery = { kind: 'bill' | 'container'; number: string };

// Letters count from 10 and skip the multiples of 11: A is 10, B 12, L 23, Z 38.
const LETTER_VALUES = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter, index) => [letter, 10 + index + Math.floor((index + 9) / 10)]));

/** The ISO 6346 check digit of a container's owner code, category and serial number. */
export function containerCheckDigit(body: string): number {
  if (!/^[A-Z]{3}[UJZ]\d{6}$/.test(body)) throw new InvalidInputError(PROVIDER, 'Container numbers are an owner code, a category letter and six digits');
  const sum = [...body].reduce((total, character, index) => total + (LETTER_VALUES.get(character) ?? Number(character)) * 2 ** index, 0);
  return sum % 11 % 10;
}

/** A whole container number with its check digit, or a bill of lading with or without its SCAC. */
export function yangMingQuery(raw: string): YangMingQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (CONTAINER.test(number)) {
    if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
    return { kind: 'container', number };
  }
  const bill = BILL.exec(number)?.[1];
  if (bill) return { kind: 'bill', number: bill };
  throw new InvalidInputError(PROVIDER, 'Yang Ming tracks a bill of lading of a letter and nine digits or a container number');
}

/**
 * The lookup for one number: `SEARCH` as the page's search asks it, or `BL_CT` for a bill's
 * container, with the bill as `refNo`, as the page asks for its moves.
 */
export const yangMingLookupUrl = (number: string, position: 'SEARCH' | 'BL_CT' = 'SEARCH', refNo = '') =>
  `${YANG_MING_LOOKUP}?${new URLSearchParams({ paramTrackNo: number, paramTrackPosition: position, paramRefNo: refNo })}`;

type Row = Record<string, unknown>;
const isRecord = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(row: Row, key: string, max = 200): string {
  const value = row[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw new SchemaError(PROVIDER, `Yang Ming returned an invalid ${key}`);
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function list(row: Row, key: string, max = MAX_ROWS): Row[] {
  const value = row[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max || !value.every(isRecord)) throw new SchemaError(PROVIDER, `Yang Ming returned an invalid ${key}`);
  return value;
}

// A place of the bill's route: its town, its state or province, and its UN/LOCODE.
const ROUTE_PLACE = /^(.+?)(?:,\s*([A-Z0-9]{1,3}))?\s*\(([A-Z]{2})[A-Z2-9]{3}\)$/;

/**
 * The zones of the bill's route by town: a US state's or Canadian province's by the code after
 * the town, another country's when it keeps one. A move at another town has no zone.
 */
function routeZones(item: Row): Map<string, string> {
  const zones = new Map<string, string>();
  const basic = isRecord(item.basicInfo) ? item.basicInfo : {};
  for (const key of ['receipt', 'loading', 'discharge', 'delivery']) {
    const place = ROUTE_PLACE.exec(text(basic, key));
    if (!place) continue;
    const [, town, region, country] = place;
    const zone = country === 'US' ? usStateTimeZone(region) : country === 'CA' ? canadaProvinceTimeZone(region) : countryTimeZone(country);
    if (zone) zones.set(townKey(town!), zone);
  }
  return zones;
}

const MOVE_DATE = /^(\d{4})\/(\d{2})\/(\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/;

/** An event's wall clock, and the instant it gives in its town's zone when the route names it. */
function stamp(moveDate: string, place: string, zones: ReadonlyMap<string, string>) {
  const parts = MOVE_DATE.exec(moveDate);
  const local = parts ? `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:00` : '';
  const year = Number(parts?.[1]);
  if (!parts || year < 2001 || year > 2100 || !isoTime(local, 'UTC')) throw new SchemaError(PROVIDER, 'Yang Ming returned an invalid event time');
  const zone = zones.get(townKey(place.split(' - ')[0]!));
  const time = zone ? isoTime(local, zone) : null;
  return time ? { local_time: local, time: time.iso, time_zone: zone!, time_zone_basis: 'place' } : { local_time: local };
}

type Move = CarrierEvent & { local_time: string };

/** One DCSA event as the reply words it; estimated and planned ones are no move yet. */
function move(row: Row, wordingKey: string, zones: ReadonlyMap<string, string>): Move | null {
  const classifier = text(row, 'eventClassifie', 20);
  if (classifier !== 'Actual') {
    if (classifier === 'Estimated' || classifier === 'Planned') return null;
    throw new SchemaError(PROVIDER, 'Yang Ming returned an event of an unknown kind');
  }
  const description = text(row, wordingKey);
  const location = text(row, wordingKey === 'lastEvent' ? 'place' : 'atFacility');
  if (!description) throw new SchemaError(PROVIDER, 'Yang Ming returned an event without wording');
  const stage = yangMingStage(description);
  return { ...stamp(text(row, 'moveDate', 20), location, zones), ...(location ? { location } : {}), description,
    ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}) };
}

const newestFirst = (left: Move, right: Move) => right.local_time.localeCompare(left.local_time);

// The stages of a container that has not moved yet.
const BEFORE_MOVING: ReadonlySet<string> = new Set<Stage>(['pending', 'registered', 'accepted']);

/**
 * A container's moves newest first, as the reply lists them. A gate in after the container moved
 * is transit; an empty container returned before it moved was not used, which is no delivery.
 * A bill's container known by its latest event alone was returned after this bill's voyage.
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

/** What the lookup answered for the number asked. */
export type YangMingLookup =
  | { kind: 'missing' }
  | { kind: 'container'; moves: Move[] }
  | { kind: 'bill'; refNo: string; zones: Map<string, string>; containers: { number: string; latest: Move | null }[] };

/** The one entry of a reply, from the list it came in. */
function entryOf(reply: unknown): { from: string; item: Row } {
  if (!isRecord(reply)) throw new SchemaError(PROVIDER, 'Yang Ming returned a reply that is not an object');
  const entries = ['blList', 'containerList', 'bookingList', 'emptyList'].flatMap(key => list(reply, key, 50).map(item => ({ from: key, item })));
  if (entries.length !== 1) throw new SchemaError(PROVIDER, 'Yang Ming returned an unexpected number of results');
  return entries[0]!;
}

function containerMoves(item: Row, number: string, zones: ReadonlyMap<string, string>): Move[] {
  if (text(item, 'queryTrackNo', 40) !== number || text(item, 'trackTypeCode', 20) !== 'CTNRNO') throw new SchemaError(PROVIDER, 'Yang Ming returned another container');
  return list(item, 'dcsaStatusInfo').map(row => move(row, 'eventDesc', zones)).filter((event): event is Move => event !== null);
}

/**
 * Yang Ming's answer for the number asked: a bill and its containers' latest events, a container's
 * moves, or no result. A bill's answer must name that bill; a container's, that container.
 */
export function yangMingLookup(reply: unknown, query: YangMingQuery): YangMingLookup {
  const { from, item } = entryOf(reply);
  if (text(item, 'queryTrackNo', 40) !== query.number) throw new SchemaError(PROVIDER, 'Yang Ming returned another number');
  if (from === 'emptyList') {
    if (!/can't identify your input/i.test(text(item, 'responeMessage', 2000))) throw new SchemaError(PROVIDER, 'Yang Ming returned an unexpected empty result');
    return { kind: 'missing' };
  }
  if (query.kind === 'container' && from === 'containerList') return { kind: 'container', moves: containerMoves(item, query.number, new Map()) };
  if (query.kind !== 'bill' || from !== 'blList' || text(item, 'trackTypeCode', 20) !== 'BLNO' || text(item, 'returnTrackNo', 40) !== query.number) {
    throw new SchemaError(PROVIDER, 'Yang Ming returned another kind of result');
  }
  const zones = routeZones(item);
  const seen = new Set<string>();
  const containers = list(item, 'dcsaContainerInfo').map(row => {
    const number = text(row, 'ctnrNo', 20);
    if (!CONTAINER.test(number) || seen.has(number)) throw new SchemaError(PROVIDER, 'Yang Ming returned an invalid container');
    seen.add(number);
    return { number, latest: text(row, 'lastEvent') ? move(row, 'lastEvent', zones) : null };
  });
  return { kind: 'bill', refNo: query.number, zones, containers };
}

/** The moves of a bill's container, from the lookup the page makes for them. */
export function yangMingDetail(reply: unknown, container: string, zones: ReadonlyMap<string, string>): Move[] {
  const { from, item } = entryOf(reply);
  if (from !== 'containerList') throw new SchemaError(PROVIDER, 'Yang Ming returned no moves for the bill\'s container');
  return containerMoves(item, container, zones);
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
 * The shipment from a lookup and the moves asked for its bill's containers: each container's
 * moves, or its latest event where they were not asked, merged newest first and those the
 * containers share kept once.
 */
export function yangMingResult(lookup: YangMingLookup, details: ReadonlyMap<string, readonly Move[]> = new Map()): CarrierResult {
  if (lookup.kind === 'missing') throw new NotFoundError(PROVIDER, 'Yang Ming does not hold this number');
  let truncated = false;
  const histories = lookup.kind === 'container' ? [containerHistory(lookup.moves, true)] : lookup.containers.map(container => {
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
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Yang Ming lists the shipment without moves', { reason: 'listed' });
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

const REFUSED = /<title>\s*(?:Access Denied|Challenge Validation)\s*<\/title>|_sec\/verify|errors\.edgesuite\.net|verify_your_identity/i;

/** A reply's JSON, or the error a page in its place stands for. */
export function yangMingJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch {
    if (REFUSED.test(body)) throw new ChallengeError(PROVIDER, 'Akamai refused Yang Ming\'s tracking lookup');
    throw new SchemaError(PROVIDER, 'Yang Ming returned a reply that is not JSON');
  }
}

/** Whether the block status names the caller's address blocked; Yang Ming then asks for a picture code. */
export function yangMingBlocked(reply: unknown): boolean {
  if (!isRecord(reply) || typeof reply.isInBlackList !== 'boolean') throw new SchemaError(PROVIDER, 'Yang Ming returned an invalid block status');
  return reply.isInBlackList;
}
