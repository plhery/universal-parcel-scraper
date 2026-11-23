import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { canadaProvinceTimeZone, countryCode, countryTimeZone, isoTime, usStateTimeZone } from '../../core/time/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { containerCheckDigit } from '../zim/parser.js';
import { goldStarLineStage } from './status.js';

export const PROVIDER = 'Gold Star Line';
/** The tracking page, which looks up the number its path ends with. */
export const GOLD_STAR_LINE_PAGE = 'https://www.goldstarline.com/tools/track_shipment';
/** The lookup the page makes, answered with JSON. */
export const GOLD_STAR_LINE_LOOKUP = 'https://www.goldstarline.com/api/cms';
export const GOLD_STAR_LINE_MAX_BYTES = 2_000_000;

const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
// Gold Star Line's bills are GOSU, its carrier code, three letters for the issuing office and the
// bill's serial number. The lookup needs the whole bill.
const BILL = /^(?:GOSU)?([A-Z]{3}\d{7,9})$/;
const MAX_LEGS = 50;
const MAX_CONTAINERS = 500;
const MAX_ACTIVITIES = 500;
const MAX_EVENTS = 500;
// The offset ZIM's lookups put on some wall clocks whatever their place's, +03:00.
const ZIM_LABEL_MINUTES = 180;

/** What Gold Star Line's page tracks: a bill of lading, or a container by its ISO 6346 number. */
export type GoldStarLineQuery = { kind: 'bill' | 'container'; number: string };

/** A whole container number with its check digit, or a bill of lading with or without `GOSU`. */
export function goldStarLineQuery(raw: string): GoldStarLineQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (CONTAINER.test(number)) {
    if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
    return { kind: 'container', number };
  }
  const bill = BILL.exec(number)?.[1];
  if (bill) return { kind: 'bill', number: `GOSU${bill}` };
  throw new InvalidInputError(PROVIDER, 'Gold Star Line tracks a bill of lading starting with GOSU or a container number');
}

/** The tracking page's link for one number, which looks it up as it loads. */
export const goldStarLinePageUrl = (query: GoldStarLineQuery) => `${GOLD_STAR_LINE_PAGE}/${query.number}`;
/** The body of the page's lookup for one number, as the page writes it. */
export const goldStarLineLookupBody = (query: GoldStarLineQuery) =>
  JSON.stringify({ action: 'get_track_shipment_val', country_code: 'HK', containerid: query.number });

type Row = JsonObject;

function text(row: Row, key: string, max = 200): string {
  const value = row[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw new SchemaError(PROVIDER, `Gold Star Line returned an invalid ${key}`);
  return value.replace(/\s+/g, ' ').trim();
}

function rows(row: Row, key: string, max: number): Row[] {
  const list = row[key];
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > max || !list.every(isRecord)) throw new SchemaError(PROVIDER, `Gold Star Line returned an invalid ${key}`);
  return list;
}

const WALL_CLOCK = /^(\d{4})-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/;

/** An activity's wall clock and the offset stated beside it, on a day the calendar has, in the years Gold Star Line can hold. */
function clockOf(row: Row): { local: string; offset: number } {
  const stated = row.activityDateTz;
  const local = isRecord(stated) ? text(stated, 'dateTime', 40) : '';
  const offset = isRecord(stated) ? stated.offsetMinutes : undefined;
  const year = Number(WALL_CLOCK.exec(local)?.[1]);
  const day = Date.parse(`${local.slice(0, 10)}T00:00:00Z`);
  if (!(year >= 2001 && year <= 2100) || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== local.slice(0, 10)
    || typeof offset !== 'number' || !Number.isInteger(offset) || offset < -720 || offset > 840) {
    throw new SchemaError(PROVIDER, 'Gold Star Line returned an activity without a valid time');
  }
  return { local: local.slice(0, 19), offset };
}

const offsetText = (minutes: number) => `${minutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${
  String(Math.abs(minutes) % 60).padStart(2, '0')}`;

/**
 * The country codes of the reply's country names, from the UN/LOCODEs of the ports its route and
 * consignment name: the reply spells some countries as no country list does, "CAMBODIA KAMPUCHEA".
 */
function countryCodes(response: Row, details: Row): ReadonlyMap<string, string> {
  const codes = new Map<string, string>();
  const add = (name: string, code: string) => {
    if (name && /^[A-Z]{2}$/.test(code) && !codes.has(name)) codes.set(name, code);
  };
  const port = (row: Row, key: string) => /^[A-Z]{2}[A-Z0-9]{3}$/.exec(text(row, key, 10))?.[0].slice(0, 2) ?? '';
  for (const leg of rows(response, 'blRouteLegs', MAX_LEGS)) {
    add(text(leg, 'countryNameFrom'), port(leg, 'portCodeFrom'));
    add(text(leg, 'countryNameTo'), port(leg, 'portCodeTo'));
  }
  for (const end of ['Pol', 'Pod', 'Del', 'Por']) {
    add(text(details, `cons${end}CountryName`), text(details, `cons${end}CountryCode`, 10) || port(details, `cons${end}`));
  }
  return codes;
}

/**
 * The zone of a place's wall clock: a US state's or a Canadian province's by the code the reply
 * puts after the town, another country's when it keeps one.
 */
function placeZone(place: string, country: string): string | null {
  const region = /\(([A-Z]{2})\)$/.exec(place)?.[1];
  if (country === 'US') return region ? usStateTimeZone(region) : null;
  if (country === 'CA') return region ? canadaProvinceTimeZone(region) : null;
  return country ? countryTimeZone(country) : null;
}

// Stages in the order a container reaches them, to order activities of one time.
const PROGRESS: readonly Stage[] = ['pending', 'registered', 'accepted', 'in_transit', 'customs', 'ready_for_pickup', 'out_for_delivery', 'delivered'];
// The stages of a container that has not moved yet.
const BEFORE_MOVING: ReadonlySet<string> = new Set<Stage>(['pending', 'registered', 'accepted']);

interface Activity { event: CarrierEvent; at: number; rank: number }

/** Newest first; of activities at one time, the further stage first and a notice last. */
const newestFirst = (left: Activity, right: Activity) => right.at - left.at || right.rank - left.rank;

/**
 * A container's activities, newest first. Most times carry their place's offset; ZIM's label
 * marks a wall clock read in its place's zone. A gate in after the container moved is transit;
 * an empty container returned before it moved was not used, which is no delivery.
 */
function containerHistory(container: Row, codes: ReadonlyMap<string, string>): Activity[] {
  const activities = rows(container, 'unitActivityList', MAX_ACTIVITIES).map(row => {
    const description = text(row, 'activityDesc');
    if (!description) throw new SchemaError(PROVIDER, 'Gold Star Line returned an invalid activity');
    const place = text(row, 'placeFromDesc');
    const countryName = text(row, 'countryFromName', 100);
    const country = codes.get(countryName) ?? countryCode(countryName) ?? '';
    const location = [place, country || countryName].filter(Boolean).join(', ');
    const { local, offset } = clockOf(row);
    const zone = offset === ZIM_LABEL_MINUTES ? placeZone(place, country) : null;
    const zoned = zone ? isoTime(local, zone) : null;
    const time = offset !== ZIM_LABEL_MINUTES ? { time: `${local}${offsetText(offset)}` }
      : zoned ? { time: zoned.iso, local_time: local, time_zone: zone!, time_zone_basis: 'place' } : { local_time: local };
    const stage = goldStarLineStage(description);
    const event = { ...time, ...(location ? { location } : {}), description,
      ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}) } satisfies CarrierEvent;
    const at = event.time ? Date.parse(event.time) : Date.parse(`${local}Z`) - offset * 60_000;
    return { event, at, rank: stage ? PROGRESS.indexOf(stage) : -1 };
  }).sort(newestFirst);
  let moved = false;
  for (const { event } of [...activities].reverse()) {
    if (event.stage === 'delivered' && !moved) {
      delete event.stage;
      delete event.stage_source;
    } else if (moved && event.stage && BEFORE_MOVING.has(event.stage)) {
      event.stage = 'in_transit';
    }
    if (event.stage && !BEFORE_MOVING.has(event.stage)) moved = true;
  }
  return activities;
}

/**
 * The stage the shipment is at. A bill's containers move apart: one returned empty does not
 * make the others delivered, so a delivery decides only once every container has one, and a
 * container without a staged activity leaves the stage open.
 */
function currentStage(histories: readonly Activity[][]): Stage | undefined {
  const latest = histories.map(activities => activities.find(activity => activity.event.stage))
    .filter((activity): activity is Activity => activity !== undefined);
  const open = latest.filter(activity => activity.event.stage !== 'delivered').sort(newestFirst)[0];
  if (open) return open.event.stage as Stage;
  return latest.length && latest.length === histories.length ? 'delivered' : undefined;
}

const containerNumber = (row: Row) => `${text(row, 'unitPrefix', 10)}${text(row, 'unitNo', 20)}`;

/** The error Gold Star Line's answer without a shipment stands for. */
function failure(response: Row): Error {
  const code = typeof response.statusCode === 'string' && /^\d{3}$/.test(response.statusCode) ? Number(response.statusCode) : response.statusCode;
  if (code === 'GSL-0016' && /^reference not found$/i.test(text(response, 'message'))) {
    return new NotFoundError(PROVIDER, 'Gold Star Line does not hold this number');
  }
  if (code === 429) return new RateLimitedError(PROVIDER);
  // The service behind the page fails some numbers, such as another ZIM line's containers.
  if (typeof code === 'number' && Number.isInteger(code) && code >= 500 && code <= 599) return new UpstreamHttpError(PROVIDER, code);
  return new SchemaError(PROVIDER, 'Gold Star Line returned an unexpected error');
}

/**
 * Gold Star Line's reply for a bill of lading or a container: each container's activities merged
 * newest first, those they share kept once. The reply must name the number asked; a container's
 * must hold that container alone.
 */
export function goldStarLineResult(reply: unknown, query: GoldStarLineQuery): CarrierResult {
  if (!isRecord(reply) || reply.status !== 'OK' || !isRecord(reply.data)) throw new SchemaError(PROVIDER, 'Gold Star Line returned an unexpected reply');
  const { status, message } = reply.data;
  if ((status !== 0 && status !== 1) || !isRecord(message) || !isRecord(message.response)) {
    throw new SchemaError(PROVIDER, 'Gold Star Line returned an unexpected reply');
  }
  if (message.containerid !== query.number) throw new SchemaError(PROVIDER, 'Gold Star Line returned another number');
  const response = message.response;
  if (status === 0) throw failure(response);
  const details = response.consignmentDetails;
  if (!isRecord(details)) throw new SchemaError(PROVIDER, 'Gold Star Line returned invalid shipment details');
  const type = text(details, 'type', 20);
  const containers = rows(details, 'consContainerList', MAX_CONTAINERS);
  if (containers.some(container => !CONTAINER.test(containerNumber(container)))) throw new SchemaError(PROVIDER, 'Gold Star Line returned an invalid container');
  if (query.kind === 'container' ? type !== 'Container' || containers.length !== 1 || containerNumber(containers[0]!) !== query.number : type !== 'BL') {
    throw new SchemaError(PROVIDER, 'Gold Star Line returned another shipment');
  }
  const codes = countryCodes(response, details);
  const histories = containers.map(container => containerHistory(container, codes));
  const seen = new Set<string>();
  const events = histories.flat().sort(newestFirst).map(activity => activity.event).filter(event => {
    const key = JSON.stringify([event.time ?? event.local_time, event.description, event.location ?? '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Gold Star Line lists the shipment without activities', { reason: 'listed' });
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

/** Gold Star Line's reply as it came, or the error an Akamai page in its place stands for. */
export function goldStarLineReplyText(body: string, query: GoldStarLineQuery): CarrierResult {
  let reply: unknown;
  try {
    reply = JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (REFUSED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Akamai refused Gold Star Line\'s tracking lookup');
    throw new SchemaError(PROVIDER, 'Gold Star Line returned tracking data that is not JSON', { cause });
  }
  return goldStarLineResult(reply, query);
}
