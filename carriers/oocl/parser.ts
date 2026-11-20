import { DateTime, FixedOffsetZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { plannedEvents } from '../../core/result/planned.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, countryTimeZone, firstOccurrence, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { ooclStage } from './status.js';

export const PROVIDER = 'OOCL';
export const OOCL_ORIGIN = 'https://www.oocl.com';
/** The site's link into cargo tracking, which hands the number to the tracker as a ticket. */
export const OOCL_LINK_PATH = '/Pages/ExpressLink.aspx';
export const OOCL_TRACKER_ORIGIN = 'https://pbcontroltower.digital.oocl.com';
export const OOCL_TRACKER_PAGE = `${OOCL_TRACKER_ORIGIN}/scct/public/moc/cargoTracking`;
const API = `${OOCL_TRACKER_ORIGIN}/scct/scct_customer/public/moc-cargo-tracking`;
/** The shipments the ticket names, each with its containers' milestones and its route. */
export const OOCL_SUMMARY = `${API}/summary`;
/** Whether the tracker asks the page for a CAPTCHA before it looks anything up. */
export const OOCL_CAPTCHA_CONFIG = `${API}/captcha-config`;
export const OOCL_MAX_BYTES = 2_000_000;

// The tracker's script decrypts every reply with AES-GCM under this key, the same for every visitor.
export const OOCL_REPLY_KEY = 'b3Ay6#9f1a@%&2^6'; // gitleaks:allow
// Cloudflare answers a client it stops with a page of its own.
const CHALLENGED = /<title>\s*Just a moment|challenge-platform|cf-mitigated|<title>\s*403 Forbidden/i;
const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
// OOCL's bills of lading are its carrier code and the booking's ten digits; the tracker takes the digits.
const BILL = /^(?:OOLU)?(\d{10})$/;
// "06 Nov 2026 12:48 EST": a place's wall clock and the name of its clock.
const EVENT_TIME = /^(\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2})(?: ([A-Z]{2,5}))?$/;
const ROUTE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_ROWS = 200;
const EARLIEST_YEAR = 2001;
const LATEST_YEAR = 2100;

/**
 * The clocks OOCL names its times by, in minutes from UTC. A name that countries use for
 * different clocks is read by the place's country: CST is China's clock in China and Taiwan,
 * which OOCL files under China, and North America's central clock there.
 */
const CLOCKS: Readonly<Record<string, number | Readonly<Record<string, number>>>> = {
  UTC: 0, GMT: 0, WET: 0, WEST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180, MSK: 180, TRT: 180, SAST: 120,
  GST: 240, PKT: 300, ICT: 420, WIB: 420, SGT: 480, MYT: 480, HKT: 480, PHT: 480, AWST: 480, JST: 540, KST: 540,
  AEST: 600, AEDT: 660, NZST: 720, NZDT: 780,
  EST: -300, EDT: -240, CDT: -300, MST: -420, MDT: -360, PDT: -420, AKST: -540, AKDT: -480, HST: -600, NST: -210, NDT: -150,
  BRT: -180, ART: -180, CLT: -240, CLST: -180, PET: -300, COT: -300,
  CST: { US: -360, CA: -360, MX: -360, CN: 480, TW: 480, HK: 480, MO: 480 },
  PST: { US: -480, CA: -480, MX: -480 },
  IST: { IN: 330 },
  BST: { GB: 60 },
  AST: { CA: -240, SA: 180, KW: 180, QA: 180, BH: 180, IQ: 180 },
  ADT: { CA: -180 },
};

export type OoclQuery = { kind: 'bill' | 'container'; number: string };
/** How the tracker names what it looks a number up as. */
export type OoclLookup = 'blNumber' | 'bookingNumber' | 'containerNumber';

// Letters count from 10 and skip the multiples of 11: A is 10, B 12, L 23, Z 38.
const LETTER_VALUES = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter, index) => [letter, 10 + index + Math.floor((index + 9) / 10)]));

/** The ISO 6346 check digit of a container's owner code, category and serial number. */
export function containerCheckDigit(body: string): number {
  if (!/^[A-Z]{3}[UJZ]\d{6}$/.test(body)) throw new InvalidInputError(PROVIDER, 'Container numbers are an owner code, a category letter and six digits');
  const sum = [...body].reduce((total, character, index) => total + (LETTER_VALUES.get(character) ?? Number(character)) * 2 ** index, 0);
  return sum % 11 % 10;
}

/** What OOCL's tracker searches: a whole container number with its check digit, or a bill of lading or booking by its ten digits. */
export function ooclQuery(raw: string): OoclQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (CONTAINER.test(number)) {
    if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
    return { kind: 'container', number };
  }
  const bill = BILL.exec(number);
  if (bill) return { kind: 'bill', number: bill[1]! };
  throw new InvalidInputError(PROVIDER, 'OOCL tracks a bill of lading or booking of ten digits, also after OOLU, or a container number');
}

/** The lookups a query takes, in turn: ten digits are a bill of lading, or else a booking not yet billed. */
export const ooclLookups = (query: OoclQuery): readonly OoclLookup[] => query.kind === 'container' ? ['containerNumber'] : ['blNumber', 'bookingNumber'];

/** The site's link that opens the tracker on a number. */
export function ooclLinkUrl(number: string, lookup: OoclLookup): string {
  return `${OOCL_ORIGIN}${OOCL_LINK_PATH}?${new URLSearchParams({ eltype: 'ct', businessType: lookup, businessNumber: number, language: 'en' })}`;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
let replyKey: Promise<CryptoKey> | undefined;

/** A reply decrypted as the tracker's script decrypts it, with its envelope checked. */
export async function decryptOoclReply(body: string): Promise<Record<string, unknown>> {
  if (CHALLENGED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Cloudflare stopped OOCL\'s tracker');
  let wrapped: unknown;
  try {
    wrapped = JSON.parse(body);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'OOCL returned a reply that is not JSON', { cause });
  }
  let reply: unknown = wrapped;
  if (typeof wrapped === 'string') {
    try {
      const bytes = Uint8Array.from(atob(wrapped), character => character.charCodeAt(0));
      // Twelve bytes of nonce, then the ciphertext and its tag.
      if (bytes.length < 28) throw new RangeError('short');
      replyKey ??= crypto.subtle.importKey('raw', new TextEncoder().encode(OOCL_REPLY_KEY), { name: 'AES-GCM' }, false, ['decrypt']);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await replyKey, bytes.slice(12));
      reply = JSON.parse(utf8.decode(plain));
    } catch (cause) {
      throw new SchemaError(PROVIDER, 'OOCL returned a reply that does not decrypt', { cause });
    }
  }
  if (!isRecord(reply)) throw new SchemaError(PROVIDER, 'OOCL returned a reply without its envelope');
  if (reply.code === '429') throw new RateLimitedError(PROVIDER);
  if (reply.code !== '200' || reply.success !== true) throw new SchemaError(PROVIDER, 'OOCL returned an error');
  return reply;
}

const text = (record: Record<string, unknown>, key: string, maxLength = 200): string => {
  const value = record[key];
  if (value !== null && value !== undefined && typeof value !== 'string') throw new SchemaError(PROVIDER, `OOCL returned an invalid ${key}`);
  return clean(value, maxLength);
};
const rowsOf = (record: Record<string, unknown>, key: string): Record<string, unknown>[] => {
  const value = record[key];
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ROWS || !value.every(isRecord)) throw new SchemaError(PROVIDER, `OOCL returned an invalid ${key}`);
  return value;
};
const stringsOf = (value: unknown): string[] => {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ROWS || !value.every(item => typeof item === 'string')) throw new SchemaError(PROVIDER, 'OOCL returned invalid bills of lading');
  return value.map(item => clean(item, 40));
};

/** A wall clock in the ISO form, or a schema failure for one OOCL could not have meant. */
function wall(year: number, month: number, day: number, hour: number, minute: number, second = 0): string {
  const parsed = DateTime.fromObject({ year, month, day, hour, minute, second }, { zone: 'utc' });
  if (!parsed.isValid || year < EARLIEST_YEAR || year > LATEST_YEAR) throw new SchemaError(PROVIDER, 'OOCL returned an invalid date');
  return parsed.toISO({ includeOffset: false, suppressMilliseconds: true });
}

interface Clock { readonly local: string; readonly label: string }

/** A milestone's "06 Nov 2026 12:48 EST", or none for an empty one. */
function eventClock(record: Record<string, unknown>, key: string): Clock | null {
  const value = text(record, key, 40);
  if (!value) return null;
  const match = EVENT_TIME.exec(value);
  if (!match) throw new SchemaError(PROVIDER, 'OOCL returned an invalid date');
  const [, day, month, year, hour, minute, label] = match;
  return { local: wall(Number(year), MONTHS.indexOf(month!) + 1, Number(day), Number(hour), Number(minute)), label: label ?? '' };
}

/** A vessel's call time, its wall clock and the name of its clock in separate fields. */
function routeClock(record: Record<string, unknown>, key: string, labelKey: string): Clock | null {
  const value = text(record, key, 40);
  if (!value) return null;
  const parsed = ROUTE_TIME.test(value) ? DateTime.fromISO(value, { zone: 'utc' }) : null;
  if (!parsed?.isValid) throw new SchemaError(PROVIDER, 'OOCL returned an invalid date');
  return { local: wall(parsed.year, parsed.month, parsed.day, parsed.hour, parsed.minute, parsed.second), label: text(record, labelKey, 8) };
}

/**
 * A time on the clock OOCL names, as the instant that clock gives it. A clock it does not name,
 * or names by a label this adapter does not know, is read in the zone of a country that keeps
 * one; otherwise the wall clock is kept alone.
 */
function stamp(clock: Clock, country: string | null): Pick<CarrierEvent, 'time' | 'local_time' | 'time_zone' | 'time_zone_basis'> {
  const known = CLOCKS[clock.label];
  const offset = typeof known === 'number' ? known : known && country ? known[country] : undefined;
  if (offset !== undefined) {
    const time = firstOccurrence(DateTime.fromISO(clock.local, { zone: FixedOffsetZone.instance(offset) })).toISO({ suppressMilliseconds: true });
    if (time) return { time };
  }
  const zone = country ? countryTimeZone(country) : null;
  const time = zone ? isoTime(clock.local, zone) : null;
  return time ? { local_time: clock.local, time: time.iso, time_zone: zone!, time_zone_basis: 'place' } : { local_time: clock.local };
}

/** A place of the route: its facility and the country OOCL files it under. */
interface Stop { readonly facility: string; readonly country: string | null }

/**
 * A town as OOCL writes it, "Boston,Suffolk, Massachusetts, United States", without the
 * county, and the country it names, if it names one.
 */
function town(value: string): { name: string; country: string | null } {
  const parts = value.split(',').map(part => part.trim()).filter(Boolean);
  if (parts.length >= 4) parts.splice(1, 1);
  return { name: parts.join(', '), country: parts.length > 1 ? countryCode(parts.at(-1)) : null };
}

/**
 * The country of a place: the one its town names, or the one the route files its facility,
 * or another facility of the same town, under.
 */
function countryOf(named: string | null, facility: string, stops: readonly Stop[]): string | null {
  if (named) return named;
  const stop = stops.find(item => item.facility === facility)
    ?? (/^[A-Z]{3}/.test(facility) ? stops.find(item => item.facility.slice(0, 3) === facility.slice(0, 3)) : undefined);
  return stop?.country ?? null;
}

function placeName(facility: string, townName: string): string | undefined {
  const parts = [facility, townName].filter(Boolean);
  return parts.length ? parts.join(', ') : undefined;
}

const order = (item: CarrierEvent) => item.time ? Date.parse(item.time) : Date.parse(`${item.local_time}Z`);
const newestFirst = (left: CarrierEvent, right: CarrierEvent) => order(right) - order(left);

/** A container's milestones, each on its place's clock. */
function milestones(container: Record<string, unknown>, stops: readonly Stop[]): CarrierEvent[] {
  return rowsOf(container, 'milestoneEventList').map(row => {
    const name = text(row, 'eventName', 100);
    const clock = eventClock(row, 'eventDateTime');
    if (!name || !clock) throw new SchemaError(PROVIDER, 'OOCL returned a milestone without its name or time');
    const leg = text(row, 'stage', 40);
    const facility = text(row, 'facilityCode', 20);
    const place = town(text(row, 'city') || text(row, 'portName'));
    const code = leg ? `${name} (${leg})` : name;
    const stage = ooclStage(code);
    const location = placeName(text(row, 'facilityName'), place.name);
    return { ...stamp(clock, countryOf(place.country, facility, stops)), ...(location ? { location } : {}), description: name,
      provider_code: code, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  });
}

/**
 * The vessel calls still to come: a departure from the first port of loading or a port of
 * transshipment without its actual time, and the arrival at the last port of discharge.
 */
function vesselPlans(routes: readonly Record<string, unknown>[], stops: readonly Stop[]): CarrierEvent[] {
  return routes.flatMap(route => {
    const vessel = isRecord(route.vesselInfo) ? route.vesselInfo : null;
    if (!vessel) return [];
    const kind = text(route, 'specificLocationType', 40);
    const place = town(text(route, 'city') || text(route, 'portName'));
    const facility = text(route, 'facilityCode', 20);
    const country = countryOf(place.country, facility, stops);
    const location = placeName(text(route, 'facilityName'), place.name);
    const plan = (clock: Clock, description: string, stage: Stage): CarrierEvent =>
      ({ ...stamp(clock, country), description, ...(location ? { location } : {}), stage });
    const steps: CarrierEvent[] = [];
    const departs = routeClock(vessel, 'etdLocalDatetime', 'etdTimeZone');
    if ((kind === 'FPOL' || kind === 'TRANSSHIPMENT') && departs && !routeClock(vessel, 'atdLocalDatetime', 'atdTimeZone')) {
      steps.push(plan(departs, 'Departure', 'in_transit'));
    }
    const arrives = routeClock(vessel, 'etaLocalDatetime', 'etaTimeZone');
    if (kind === 'LPOD' && arrives && !routeClock(vessel, 'ataLocalDatetime', 'ataTimeZone')) steps.push(plan(arrives, 'Arrival', 'in_transit'));
    return steps;
  });
}

/**
 * The shipments a summary reply holds for the number it was asked about, or null when it
 * holds none. A bill of lading or booking reads every container's milestones; a container
 * reads its own. Each milestone keeps the clock OOCL names for it. Vessel calls OOCL still
 * expects are planned steps.
 */
export function ooclResult(reply: Record<string, unknown>, query: OoclQuery, lookup: OoclLookup): CarrierResult | null {
  if (!isRecord(reply.result)) throw new SchemaError(PROVIDER, 'OOCL returned a reply without its result');
  const found = reply.result;
  if (text(found, 'businessNumber', 40) !== query.number || text(found, 'businessNumberType', 40) !== lookup) {
    throw new SchemaError(PROVIDER, 'OOCL returned another lookup');
  }
  const summaries = rowsOf(found, 'summaryList');
  if (!summaries.length) return null;
  const events: CarrierEvent[] = [];
  const planned: CarrierEvent[] = [];
  for (const summary of summaries) {
    const containers = rowsOf(summary, 'containerList');
    const routes = rowsOf(summary, 'routes');
    const stops: Stop[] = routes.map(route => ({ facility: text(route, 'facilityCode', 20), country: countryCode(text(route, 'countryCode', 4)) }));
    let read = containers;
    if (query.kind === 'container') {
      read = containers.filter(container => text(container, 'containerNumberWithCheckDigit', 20) === query.number);
      if (!read.length) throw new SchemaError(PROVIDER, 'OOCL returned another container');
    } else {
      const bills = isRecord(summary.blStatus) ? Object.keys(summary.blStatus) : [];
      const held = text(summary, 'bookingNumber', 40) === query.number
        || lookup === 'blNumber' && (bills.includes(query.number) || containers.some(container => stringsOf(container.blNumbers).includes(query.number)));
      if (!held) throw new SchemaError(PROVIDER, 'OOCL returned another shipment');
    }
    for (const container of read) events.push(...milestones(container, stops));
    planned.push(...vesselPlans(routes, stops));
  }
  const steps = plannedEvents(planned);
  const seen = new Set<string>();
  const history = events.sort(newestFirst).filter(item => {
    const key = JSON.stringify([item.time ?? item.local_time, item.provider_code, item.location ?? '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!history.length) {
    throw new NoHistoryError(PROVIDER, 'OOCL lists the shipment without milestones', { reason: 'listed', ...(steps.length ? { plannedEvents: steps } : {}) });
  }
  const newest = history[0]!;
  const stage = history.find(item => item.stage)?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description ?? null,
    ...(newest.time ? { last_update: newest.time } : { last_update: null, last_update_local: newest.local_time! }),
    expected_delivery: null, events: history, ...(steps.length ? { planned_events: steps } : {}),
  };
}

/** The answer when no lookup a query takes holds it. */
export const notHeld = (query: OoclQuery) => new NotFoundError(PROVIDER,
  query.kind === 'container' ? 'OOCL does not hold this container' : 'OOCL does not hold this bill of lading or booking');
