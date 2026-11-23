import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { canadaProvinceTimeZone, countryTimeZone, isoTime, usStateTimeZone } from '../../core/time/index.js';
import { zimStage } from './status.js';

export const PROVIDER = 'ZIM';
/** The tracking page, which looks up the number in its `consnumber` parameter. */
export const ZIM_PAGE = 'https://www.zim.com/tools/track-a-shipment';
/** The lookup the page makes, answered with JSON. */
export const ZIM_LOOKUP = 'https://apigw.zim.com/digital/TrackShipment/v2/complete-result';
// The page sends every visitor this key for its lookups; it is not an account's.
export const ZIM_SUBSCRIPTION_KEY = '9d63cf020a4c4708a7b0ebfe39578300'; // gitleaks:allow
export const ZIM_MAX_BYTES = 2_000_000;

const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
// ZIM's bills are ZIMU, its carrier code, three letters for the issuing office and the bill's
// serial number. The lookup needs the whole bill.
const BILL = /^(?:ZIMU)?([A-Z]{3}\d{7,9})$/;
const MAX_CONTAINERS = 500;
const MAX_ACTIVITIES = 500;
const MAX_EVENTS = 500;

/** What ZIM's page tracks: a bill of lading, or a container by its ISO 6346 number. */
export type ZimQuery = { kind: 'bill' | 'container'; number: string };

// Letters count from 10 and skip the multiples of 11: A is 10, B 12, L 23, Z 38.
const LETTER_VALUES = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter, index) => [letter, 10 + index + Math.floor((index + 9) / 10)]));

/** The ISO 6346 check digit of a container's owner code, category and serial number. */
export function containerCheckDigit(body: string): number {
  if (!/^[A-Z]{3}[UJZ]\d{6}$/.test(body)) throw new InvalidInputError(PROVIDER, 'Container numbers are an owner code, a category letter and six digits');
  const sum = [...body].reduce((total, character, index) => total + (LETTER_VALUES.get(character) ?? Number(character)) * 2 ** index, 0);
  return sum % 11 % 10;
}

/** A whole container number with its check digit, or a bill of lading with or without `ZIMU`. */
export function zimQuery(raw: string): ZimQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (CONTAINER.test(number)) {
    if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
    return { kind: 'container', number };
  }
  const bill = BILL.exec(number)?.[1];
  if (bill) return { kind: 'bill', number: `ZIMU${bill}` };
  throw new InvalidInputError(PROVIDER, 'ZIM tracks a bill of lading starting with ZIMU or a container number');
}

/** The lookup the page makes for one number. */
export const zimLookupUrl = (query: ZimQuery) =>
  `${ZIM_LOOKUP}?${new URLSearchParams({ reference: query.number, 'subscription-key': ZIM_SUBSCRIPTION_KEY })}`;
/** The tracking page's link for one number, which looks it up as it loads. */
export const zimPageUrl = (query: ZimQuery) => `${ZIM_PAGE}?${new URLSearchParams({ consnumber: query.number })}`;

type Row = Record<string, unknown>;
const isRecord = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(row: Row, key: string, max = 200): string {
  const value = row[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw new SchemaError(PROVIDER, `ZIM returned an invalid ${key}`);
  return value.replace(/\s+/g, ' ').trim();
}

function rows(row: Row, key: string, inner: string, max: number): Row[] {
  const holder = row[key];
  if (holder === undefined || holder === null) return [];
  const list = isRecord(holder) ? holder[inner] : undefined;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > max || !list.every(isRecord)) throw new SchemaError(PROVIDER, `ZIM returned an invalid ${inner}`);
  return list;
}

const STATED = /^(\d{4})-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;

/** Whether a time is well formed, on a day the calendar has, in the years ZIM can hold. */
function validTime(value: string): boolean {
  const year = Number(STATED.exec(value)?.[1]);
  const day = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  return year >= 2001 && year <= 2100 && Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === value.slice(0, 10)
    && Number.isFinite(Date.parse(value));
}

/**
 * The zone of a place's wall clock: a US state's or a Canadian province's by the code ZIM puts
 * after the town, another country's when it keeps one.
 */
function placeZone(place: string, country: string): string | null {
  const region = /\(([A-Z]{2})\)$/.exec(place)?.[1];
  if (country === 'US') return region ? usStateTimeZone(region) : null;
  if (country === 'CA') return region ? canadaProvinceTimeZone(region) : null;
  return country ? countryTimeZone(country) : null;
}

/**
 * When an activity happened. A bill's reply states each time with its place's offset. A
 * container's reply labels some wall clocks with an offset of ZIM's own, and a reply that states
 * no time gives the wall clock in another field under its server's offset: these are read as
 * wall clocks in their place's zone.
 */
function stamp(row: Row, zone: string | null, statesOffsets: boolean): Pick<CarrierEvent, 'time' | 'local_time' | 'time_zone' | 'time_zone_basis'> {
  const stated = text(row, 'activityDateTz', 40);
  const reading = stated || text(row, 'activityDate', 40);
  if (!reading || !validTime(reading)) throw new SchemaError(PROVIDER, 'ZIM returned an activity without a valid time');
  if (stated && statesOffsets) return { time: stated };
  const local = reading.slice(0, 19);
  const time = zone ? isoTime(local, zone) : null;
  return time ? { time: time.iso, local_time: local, time_zone: zone!, time_zone_basis: 'place' } : { local_time: local };
}

const instant = (event: CarrierEvent) => event.time ? Date.parse(event.time) : Date.parse(`${event.local_time}Z`);
const newestFirst = (left: CarrierEvent, right: CarrierEvent) => instant(right) - instant(left);

// The stages of a container that has not moved yet.
const BEFORE_MOVING: ReadonlySet<string> = new Set<Stage>(['pending', 'registered', 'accepted']);

/**
 * A container's activities, newest first. A gate in after the container moved, at the port of
 * loading after an inland depot for instance, is transit; an empty container returned before it
 * moved was not used, which is no delivery.
 */
function containerHistory(container: Row, statesOffsets: boolean): CarrierEvent[] {
  const events = rows(container, 'unitActivities', 'unitActivitiesItem', MAX_ACTIVITIES).map(row => {
    const code = text(row, 'activityCode', 60);
    const description = text(row, 'activityDesc');
    if (!/^[A-Z][A-Z0-9_]{1,59}$/.test(code) || !description) throw new SchemaError(PROVIDER, 'ZIM returned an invalid activity');
    const place = text(row, 'placeFromDesc');
    const country = text(row, 'countryFromCode', 10);
    if (country && !/^[A-Z]{2}$/.test(country)) throw new SchemaError(PROVIDER, 'ZIM returned an invalid country');
    const location = [place, country].filter(Boolean).join(', ');
    const stage = zimStage(code);
    return { ...stamp(row, placeZone(place, country), statesOffsets), ...(location ? { location } : {}), description, provider_code: code,
      ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}) } satisfies CarrierEvent;
  // ZIM lists them oldest first: of two at one time, the later listed comes first.
  }).reverse().sort(newestFirst);
  let moved = false;
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

/**
 * The stage the shipment is at. A bill's containers move apart: one returned empty does not
 * make the others delivered, so a delivery decides only once every container has one, and a
 * container without a staged activity leaves the stage open.
 */
function currentStage(histories: readonly CarrierEvent[][]): Stage | undefined {
  const latest = histories.map(events => events.find(event => event.stage)).filter((event): event is CarrierEvent => event !== undefined);
  const open = latest.filter(event => event.stage !== 'delivered').sort(newestFirst)[0];
  if (open) return open.stage as Stage;
  return latest.length && latest.length === histories.length ? 'delivered' : undefined;
}

const containerNumber = (row: Row) => `${text(row, 'unitPrefix', 10)}${text(row, 'unitNo', 20)}`;

/**
 * The error for a container ZIM says another of its lines holds: the result's code names that
 * line in the reply's `carriers`. Gold Star Line's are handed to it; the other lines are not in
 * the catalog and are another carrier's.
 */
function heldByLine(reply: Row, code: string, query: ZimQuery): Error | null {
  const lines = Array.isArray(reply.carriers) ? reply.carriers.filter(isRecord) : [];
  const line = code ? lines.find(entry => entry.carrier === code || entry.code === code) : undefined;
  const name = line && typeof line.carrier === 'string' && /^[A-Z]{2,6}$/.test(line.carrier) ? line.carrier : '';
  if (!name || name === 'ZIM') return null;
  if (name === 'GSL') {
    return new NoHistoryError(PROVIDER, 'ZIM says Gold Star Line holds this container', { deliveryCarrier: 'gold-star-line', deliveryTrackingNumber: query.number });
  }
  return new InvalidInputError(PROVIDER, `ZIM says its line ${name} holds this container`, { reason: 'other_carrier' });
}

/** The containers a reply holds for the number asked, or the error ZIM's answer stands for. */
function containersOf(reply: Row, query: ZimQuery): Row[] {
  if (query.kind === 'container') {
    const units = reply.unitListItem;
    if (!Array.isArray(units) || units.length !== 1 || !isRecord(units[0])) throw new SchemaError(PROVIDER, 'ZIM returned an invalid container lookup');
    const unit = units[0];
    if (containerNumber(unit) !== query.number) throw new SchemaError(PROVIDER, 'ZIM returned another container');
    const result = isRecord(unit.result) ? unit.result : {};
    if (text(result, 'returnCode', 10) === '0' && /^Not found/i.test(text(result, 'returnMessage'))) {
      throw new NotFoundError(PROVIDER, 'ZIM does not hold this container');
    }
    const code = text(result, 'returnCode', 10);
    if (code !== '1') throw heldByLine(reply, code, query) ?? new SchemaError(PROVIDER, 'ZIM returned an unexpected container result');
    return [unit];
  }
  const items = reply.consgListItem;
  if (!Array.isArray(items) || items.length !== 1 || !isRecord(items[0])) throw new SchemaError(PROVIDER, 'ZIM returned an invalid shipment lookup');
  const item = items[0];
  if (text(item, 'referenceNo', 40) !== query.number) throw new SchemaError(PROVIDER, 'ZIM returned another number');
  const result = isRecord(item.result) ? item.result : {};
  const type = text(item, 'referenceType', 10);
  if (type === 'ER' && text(result, 'returnCode', 10) === '-1') throw new NotFoundError(PROVIDER, 'ZIM does not hold this bill of lading');
  if (type !== 'BL' || text(result, 'returnCode', 10) !== '1') throw new SchemaError(PROVIDER, 'ZIM returned an unexpected shipment result');
  const details = item.consDetails;
  if (details !== undefined && !isRecord(details)) throw new SchemaError(PROVIDER, 'ZIM returned invalid shipment details');
  return details ? rows(details, 'consContainers', 'consContainersItem', MAX_CONTAINERS) : [];
}

/**
 * ZIM's reply for a bill of lading or a container: each container's activities merged newest
 * first, those they share kept once. A bill's reply must name the bill; a container's, the
 * container.
 */
export function zimResult(reply: unknown, query: ZimQuery): CarrierResult {
  if (!isRecord(reply)) throw new SchemaError(PROVIDER, 'ZIM returned a reply that is not an object');
  if (reply.isServerTimeOut === true) throw new UpstreamHttpError(PROVIDER, 504);
  if (reply.isSuccess !== true) throw new SchemaError(PROVIDER, 'ZIM returned an unsuccessful reply');
  const containers = containersOf(reply, query);
  if (containers.some(container => !CONTAINER.test(containerNumber(container)))) throw new SchemaError(PROVIDER, 'ZIM returned an invalid container');
  const histories = containers.map(container => containerHistory(container, query.kind === 'bill'));
  const seen = new Set<string>();
  const events = histories.flat().sort(newestFirst).filter(event => {
    const key = JSON.stringify([event.time ?? event.local_time, event.provider_code, event.location ?? '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!events.length) throw new NoHistoryError(PROVIDER, 'ZIM lists the shipment without activities', { reason: 'listed' });
  const newest = events[0]!;
  const stage = currentStage(histories);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description ?? null,
    ...(newest.time ? { last_update: newest.time } : { last_update: null, last_update_local: newest.local_time! }),
    expected_delivery: null, ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}), events: events.slice(0, MAX_EVENTS),
  };
}

const REFUSED = /<title>\s*(?:Access Denied|Challenge Validation)\s*<\/title>|_sec\/verify|errors\.edgesuite\.net/i;

/** ZIM's reply as it came, or the error an Akamai page in its place stands for. */
export function zimReplyText(body: string, query: ZimQuery): CarrierResult {
  let reply: unknown;
  try {
    reply = JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (REFUSED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Akamai refused ZIM\'s tracking lookup');
    throw new SchemaError(PROVIDER, 'ZIM returned tracking data that is not JSON', { cause });
  }
  return zimResult(reply, query);
}
