import { DateTime, IANAZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { plannedEvents } from '../../core/result/planned.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime, timeZoneCountry } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { coscoStage } from './status.js';

export const PROVIDER = 'COSCO SHIPPING Lines';
export const COSCO_ORIGIN = 'https://elines.coscoshipping.com';
/** The cargo tracking page, which routes a number given in its address to its result view. */
export const COSCO_PAGE_PATH = '/scct/public/ct/base';
const API = `${COSCO_ORIGIN}/scct/scct_customer_ex/public/cargoTracking`;
/** A bill of lading's or booking's summary, its chain of milestones and its vessel legs. */
export const COSCO_DETAIL = `${API}/detail`;
/** The bookings a container serves, each with its latest milestone. */
export const COSCO_CONTAINERS = `${API}/containers`;
/** What the page asks first: the booking a number belongs to, empty for none. */
export const COSCO_EXISTS = `${API}/shipmentExists`;
export const COSCO_MAX_BYTES = 1_000_000;

// The page's script reads every reply as base64 XORed with this key, the same for every visitor.
export const COSCO_REPLY_KEY = 'b3Ay6#9f1a@%&2^6'; // gitleaks:allow
// Wangsu's bot manager answers a client it blocks with a page of its own.
const BLOCKED = /_bot_sbu|blocksrc\.haplat\.net|sbu_hc\.js|<title>\s*403 Forbidden/i;
const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
// COSCO's bills of lading are its carrier code and the booking's ten digits; the page takes the digits.
const BILL = /^(?:COSU)?(\d{10})$/;
const WALL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;
const MASKED = /^\*+$/;
const VESSEL_EVENTS = new Set(['ATD', 'ATA', 'ETD', 'ETA']);
const MAX_ROWS = 200;
const EARLIEST_YEAR = 2001;
const LATEST_YEAR = 2100;

export type CoscoQuery = { kind: 'bill' | 'container'; number: string };

// Letters count from 10 and skip the multiples of 11: A is 10, B 12, L 23, Z 38.
const LETTER_VALUES = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter, index) => [letter, 10 + index + Math.floor((index + 9) / 10)]));

/** The ISO 6346 check digit of a container's owner code, category and serial number. */
export function containerCheckDigit(body: string): number {
  if (!/^[A-Z]{3}[UJZ]\d{6}$/.test(body)) throw new InvalidInputError(PROVIDER, 'Container numbers are an owner code, a category letter and six digits');
  const sum = [...body].reduce((total, character, index) => total + (LETTER_VALUES.get(character) ?? Number(character)) * 2 ** index, 0);
  return sum % 11 % 10;
}

/** What COSCO's page searches: a whole container number with its check digit, or a bill of lading or booking by its ten digits. */
export function coscoQuery(raw: string): CoscoQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (CONTAINER.test(number)) {
    if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
    return { kind: 'container', number };
  }
  const bill = BILL.exec(number);
  if (bill) return { kind: 'bill', number: bill[1]! };
  throw new InvalidInputError(PROVIDER, 'COSCO tracks a bill of lading or booking of ten digits, also after COSU, or a container number');
}

/** The type the page names a query's number by. A booking is searched as a bill of lading too. */
export const coscoNumberType = (query: CoscoQuery) => query.kind === 'container' ? 'containerNumber' : 'blNumber';

/** The body the page posts for a query to each of its lookups. */
export function coscoRequestBody(query: CoscoQuery): string {
  return JSON.stringify({ businessNumber: query.number, businessNumberType: coscoNumberType(query), notFilterResult: false });
}

/** The page's address for a query: it looks the number up as it loads. */
export function coscoPageUrl(query: CoscoQuery): string {
  return `${COSCO_ORIGIN}${COSCO_PAGE_PATH}?${new URLSearchParams({ lang: 'en',
    trackingType: query.kind === 'container' ? 'CONTAINER' : 'BILLOFLADING', number: query.number })}`;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** A reply decoded as the page's script decodes it, with its envelope checked. */
export function decodeCoscoReply(body: string): Record<string, unknown> {
  if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'COSCO\'s bot manager blocked the lookup');
  let wrapped: unknown;
  try {
    wrapped = JSON.parse(body);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'COSCO returned a reply that is not JSON', { cause });
  }
  let reply: unknown = wrapped;
  if (typeof wrapped === 'string') {
    try {
      const encoded = atob(wrapped);
      reply = JSON.parse(utf8.decode(Uint8Array.from(encoded, (character, index) => character.charCodeAt(0) ^ COSCO_REPLY_KEY.charCodeAt(index % COSCO_REPLY_KEY.length))));
    } catch (cause) {
      throw new SchemaError(PROVIDER, 'COSCO returned a reply that does not decode', { cause });
    }
  }
  if (!isRecord(reply)) throw new SchemaError(PROVIDER, 'COSCO returned a reply without its envelope');
  if (reply.code === '429') throw new RateLimitedError(PROVIDER);
  if (reply.code !== '200' || reply.success !== true) throw new SchemaError(PROVIDER, 'COSCO returned an error');
  return reply;
}

const text = (record: Record<string, unknown>, key: string, maxLength = 200): string => {
  const value = record[key];
  if (value !== null && value !== undefined && typeof value !== 'string') throw new SchemaError(PROVIDER, `COSCO returned an invalid ${key}`);
  return clean(value, maxLength);
};
const recordOf = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = record[key];
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) throw new SchemaError(PROVIDER, `COSCO returned an invalid ${key}`);
  return value;
};
const rowsOf = (record: Record<string, unknown>, key: string): Record<string, unknown>[] => {
  const value = record[key];
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ROWS || !value.every(isRecord)) throw new SchemaError(PROVIDER, `COSCO returned an invalid ${key}`);
  return value;
};

/** A wall clock COSCO gives, or none for an empty one or the `N/A` it writes for a step it will not estimate. */
function wallClock(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null || value === undefined || value === '' || value === 'N/A') return null;
  const parsed = typeof value === 'string' && WALL_TIME.test(value) ? DateTime.fromISO(value, { zone: 'utc' }) : null;
  if (!parsed?.isValid || parsed.year < EARLIEST_YEAR || parsed.year > LATEST_YEAR) throw new SchemaError(PROVIDER, 'COSCO returned an invalid date');
  return value as string;
}

/** A zone COSCO names for a place, or none when it names none it could mean. */
function zoneOf(record: Record<string, unknown>, key: string): string | null {
  const zone = text(record, key, 64);
  return zone && IANAZone.isValidZone(zone) ? zone : null;
}

/** A wall clock read in the zone COSCO gives its place, or kept as a wall clock without one. */
function clock(local: string, zone: string | null): Pick<CarrierEvent, 'local_time' | 'time' | 'time_zone' | 'time_zone_basis'> {
  const time = zone ? isoTime(local, zone) : null;
  return time ? { local_time: local, time: time.iso, time_zone: zone!, time_zone_basis: 'carrier' } : { local_time: local };
}

/** A port or town of the chain, as one of its rows names it. */
interface Place {
  readonly city: string;
  readonly countryName: string;
  readonly countryCode: string;
  readonly facility: string;
  readonly zone: string | null;
}

/**
 * A town and its country. COSCO files Taiwan's ports under China while giving them Taipei's
 * clock, so a country the zone contradicts is left out.
 */
function placeName(place: Pick<Place, 'city' | 'countryName' | 'countryCode' | 'zone'>): string | undefined {
  const zoneCountry = place.zone ? timeZoneCountry(place.zone) : null;
  const country = place.countryName && place.countryName !== place.city && (!zoneCountry || zoneCountry === place.countryCode) ? place.countryName : '';
  const parts = [place.city, country].filter(Boolean);
  return parts.length ? parts.join(', ') : undefined;
}

function event(local: string, zone: string | null, description: string, location: string | undefined, code?: string): CarrierEvent {
  const stage = coscoStage(code ?? null, description);
  return { ...clock(local, zone), ...(location ? { location } : {}), description, ...(code ? { provider_code: code } : {}),
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
}

const order = (item: CarrierEvent) => item.time ? Date.parse(item.time) : Date.parse(`${item.local_time}Z`);
const newestFirst = (left: CarrierEvent, right: CarrierEvent) => order(right) - order(left);

/** The result for dated events, newest first, and the steps COSCO plans. */
function result(events: CarrierEvent[], planned: CarrierEvent[], truncated: boolean, unlisted: string): CarrierResult {
  const steps = plannedEvents(planned);
  const seen = new Set<string>();
  const history = events.sort(newestFirst).filter(item => {
    const key = JSON.stringify([item.local_time, item.description, item.location ?? '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!history.length) throw new NoHistoryError(PROVIDER, unlisted, { reason: 'listed', ...(steps.length ? { plannedEvents: steps } : {}) });
  const newest = history[0]!;
  const stage = history.find(item => item.stage)?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description ?? null,
    ...(newest.time ? { last_update: newest.time } : { last_update: null, last_update_local: newest.local_time! }),
    expected_delivery: null, ...(truncated ? { history_truncated: true } : {}), events: history,
    ...(steps.length ? { planned_events: steps } : {}),
  };
}

/**
 * A bill of lading's or booking's history from the detail reply: the chain's actual milestones,
 * each vessel leg's departure and arrival, and the latest milestone, which the chain does not
 * repeat. Times are each place's wall clock, read in the zone COSCO gives it. Estimates are
 * planned steps. A reply without a summary means COSCO holds no such shipment.
 */
export function coscoBillResult(body: string, number: string): CarrierResult {
  const reply = decodeCoscoReply(body);
  const detail = recordOf(reply, 'result');
  if (detail.cargoTrackingSummary === null || detail.cargoTrackingSummary === undefined) {
    if (Object.values(detail).every(value => value === null || Array.isArray(value) && !value.length)) {
      throw new NotFoundError(PROVIDER, 'COSCO does not hold this bill of lading or booking');
    }
    throw new SchemaError(PROVIDER, 'COSCO returned a shipment without its summary');
  }
  const summary = recordOf(detail, 'cargoTrackingSummary');
  const bookings = rowsOrStrings(summary.bookingNumber);
  if (text(summary, 'blNumber', 40) !== number && !bookings.includes(number)) throw new SchemaError(PROVIDER, 'COSCO returned another shipment');

  const chain = rowsOf(detail, 'cargoTrackingFullChain');
  const legs = rowsOf(detail, 'cargoTrackingSailingSchedule');
  const places: Place[] = chain.map(row => ({ city: text(row, 'city'), countryName: text(row, 'countryName'), countryCode: text(row, 'countryCode', 4),
    facility: text(row, 'facilityCode', 20), zone: zoneOf(row, 'localTimezoneIana') }));
  const events: CarrierEvent[] = [];
  const planned: CarrierEvent[] = [];
  chain.forEach((row, index) => {
    const name = text(row, 'event', 100);
    if (!name) throw new SchemaError(PROVIDER, 'COSCO returned a milestone without its name');
    // The legs give every departure and arrival, the transshipments' too.
    if (legs.length && VESSEL_EVENTS.has(name)) return;
    const place = places[index]!;
    const actual = wallClock(row, 'actualTime');
    const estimated = wallClock(row, 'estimatedTime');
    if (actual) events.push(event(actual, place.zone, name, placeName(place), name));
    else if (estimated) planned.push(event(estimated, place.zone, name, placeName(place), name));
  });
  // A port of a leg, with the country the chain gives the same town.
  const port = (name: string, zone: string | null) => {
    const known = places.find(place => place.city === name);
    return placeName({ city: name, countryName: known?.countryName ?? '', countryCode: known?.countryCode ?? '', zone });
  };
  for (const leg of legs) {
    const from = text(leg, 'polPort');
    const to = text(leg, 'podPort');
    const fromZone = zoneOf(leg, 'polTimezoneIana');
    const toZone = zoneOf(leg, 'podTimezoneIana');
    for (const [actualKey, estimateKey, code, name, zone] of [['atd', 'etd', 'ATD', from, fromZone], ['ata', 'eta', 'ATA', to, toZone]] as const) {
      const actual = wallClock(leg, actualKey);
      const estimated = wallClock(leg, estimateKey);
      if (actual) events.push(event(actual, zone, code, port(name, zone), code));
      else if (estimated) planned.push(event(estimated, zone, code === 'ATD' ? 'ETD' : 'ETA', port(name, zone), code === 'ATD' ? 'ETD' : 'ETA'));
    }
  }

  const milestone = recordOf(summary, 'latestMilestone');
  const name = text(milestone, 'eventName', 200);
  const at = wallClock(milestone, 'actualEventDateTime');
  if (name && at) {
    // COSCO names the milestone's facility; the chain row at that facility, or at another of its town, gives its clock.
    const facility = text(milestone, 'facilityCode', 20);
    const place = facility ? places.find(item => item.facility === facility)
      ?? places.find(item => item.facility.slice(0, 3) === facility.slice(0, 3) && /^[A-Z]{3}/.test(facility)) : undefined;
    const zone = zoneOf(milestone, 'actualEventDateTimeZoneId') ?? place?.zone ?? null;
    const site = text(milestone, 'eventLocation');
    const location = [MASKED.test(site) ? '' : site, place ? placeName(place) : ''].filter(Boolean).join(', ');
    events.push(event(at, zone, name, location || undefined));
  }
  return result(events, planned, false, 'COSCO lists the shipment without milestones');
}

function rowsOrStrings(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return [clean(value, 40)];
  if (!Array.isArray(value) || value.length > MAX_ROWS || !value.every(item => typeof item === 'string')) throw new SchemaError(PROVIDER, 'COSCO returned invalid bookings');
  return value.map(item => clean(item, 40));
}

/**
 * A container's latest booking from the containers reply: its latest milestones, which COSCO
 * gives without their zone, and the arrival at the last port of discharge, which it gives in
 * that port's zone. The reply holds no earlier milestones, so the history is cut short.
 */
export function coscoContainerResult(body: string, number: string): CarrierResult {
  const rows = rowsOf(decodeCoscoReply(body), 'result');
  if (!rows.length) throw new NotFoundError(PROVIDER, 'COSCO does not hold this container');
  const matching = rows.filter(row => text(row, 'containerNumberWithCheckDigit', 20) === number);
  if (matching.length !== rows.length) throw new SchemaError(PROVIDER, 'COSCO returned another container');
  const read = matching.map(row => {
    const events = rowsOf(row, 'milestones').flatMap(milestone => {
      const name = text(milestone, 'eventName', 200);
      const at = wallClock(milestone, 'actualEventDateTime');
      if (!name || !at) return [];
      const site = text(milestone, 'eventLocationName');
      return [event(at, null, name, MASKED.test(site) ? undefined : site || undefined)];
    });
    const planned: CarrierEvent[] = [];
    const arrived = wallClock(row, 'ataAtLastPod');
    const expected = wallClock(row, 'etaAtLastPod');
    if (arrived) events.push(event(arrived, zoneOf(row, 'ataTimezoneIana'), 'ATA', undefined, 'ATA'));
    else if (expected) planned.push(event(expected, zoneOf(row, 'etaTimezoneIana'), 'ETA', undefined, 'ETA'));
    return { events, planned, latest: Math.max(-Infinity, ...events.map(order)) };
  });
  // Each row is a booking the container served; the latest is the trip it is on.
  const trip = read.reduce((latest, item) => item.latest > latest.latest ? item : latest);
  return result(trip.events, trip.planned, true, 'COSCO lists the container without milestones');
}
