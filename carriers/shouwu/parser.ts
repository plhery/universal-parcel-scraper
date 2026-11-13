import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { countryZones } from '../../places/zones.js';
import { shouwuSendsBack, shouwuStage, shouwuStatusLabel, shouwuStatusStage } from './status.js';
import { withoutCountryCode } from './place.js';

export const PROVIDER = 'Shouwu International';
// One parcel's reply is a few kilobytes.
export const SHOUWU_MAX_BYTES = 256 * 1024;

// SWECN, twelve digits and YQ: the waybills the tracker answers.
const NUMBER = /^SWECN\d{12}YQ$/;
const STATUS = /^[A-Z][A-Z0-9_]{0,63}$/;
const COUNTRY = /^[A-Z]{2}$/;
// Epoch seconds. The page reads the first ten digits, so milliseconds read as the same second.
const EPOCH = /^\d{10}(?:\d{3})?$/;
// The zone Shouwu's back office reads every scan's wall clock in.
const BACK_OFFICE = 'Asia/Shanghai';
// A facility's or a town's name. Anything with a digit, as a postcode, a street number or a phone number has, is dropped.
const PLACE = /^\p{L}[\p{L}\p{M} .,'’()&/-]{0,59}$/u;
// A row an agent files under a country's code, or under an airport's.
const COUNTRY_CODE = /^[A-Z]{2}$/;
const AIRPORT_CODE = /^[A-Z]{3}$/;
// Shouwu's or an agent's own note: Chinese, without a word in Latin letters.
const CHINESE_NOTE = /^(?!.*[A-Za-z]{2})(?=.*\p{Script=Han})/su;
// iMile, the delivering partner in Italy, opens its rows with its centre and gives a missed delivery's reason in angle brackets.
const IMILE_CENTRE = /^【[^】]+】/u;
const REASON = /^<[^<>]+>$/;
const MAX_ENTRIES = 20;
// How far a write time may stray from the clocks it is compared with.
const CLOCK_SLACK_S = 600;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
/**
 * The stages each status covers without naming them, as the page explains
 * the status: a newest scan staged one of them refines it. Shouwu's four
 * statuses name no handover, customs, delivery round, pickup point or return.
 */
const REFINES: Partial<Record<Stage, ReadonlySet<string>>> = {
  registered: new Set(['accepted']),
  in_transit: new Set(['accepted', 'customs', 'out_for_delivery', 'failed_attempt', 'ready_for_pickup', 'returned', 'exception']),
  failed_attempt: new Set(['ready_for_pickup', 'returned', 'exception']),
  // Delivered does not say to whom: a return delivered to its sender is returned.
  delivered: new Set(['returned']),
};

/** A Shouwu waybill in capitals; anything else is not one Shouwu issues. */
export function normalizeShouwuNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Shouwu International waybills are SWECN, twelve digits and YQ');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Shouwu returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's wall clock, from epoch seconds as a number or digits. Shouwu's
 * back office reads a scan's wall clock on Beijing time, an airline's or a
 * delivering partner's abroad too, so the epoch shows the scan's own wall
 * clock in Beijing (`onEpoch` names the rows abroad it does not). The page
 * shows no time for an empty or zero value, and neither is read as one.
 */
function scanClock(row: Record<string, unknown>): { seconds: number; wall: string } | null {
  const value = row.traceTime;
  if (value === null || value === undefined || value === '' || value === 0) return null;
  const digits = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  const seconds = EPOCH.test(digits) ? Number(digits.slice(0, 10)) : 0;
  if (seconds <= 0) throw new SchemaError(PROVIDER, 'Shouwu returned an invalid scan time');
  return { seconds, wall: DateTime.fromSeconds(seconds, { zone: BACK_OFFICE }).toFormat("yyyy-MM-dd'T'HH:mm:ss") };
}

/**
 * Whether a scan's epoch is its instant though its place is abroad: a note an
 * agent writes in China under the destination's code, iMile's rows, which iMile
 * dates with their offset, and an agent's own rows under an airport's code.
 */
function onEpoch(row: Record<string, unknown>, description: string, location: string): boolean {
  if (IMILE_CENTRE.test(description)) return true;
  if (COUNTRY_CODE.test(location)) return CHINESE_NOTE.test(description) || REASON.test(description);
  return AIRPORT_CODE.test(location) && text(row, 'traceType', 64) === 'TRACE_TYPE_TAIL';
}

/** When Shouwu wrote a row (`createTs`), in epoch seconds; null without a readable one. */
function writtenAt(row: Record<string, unknown>): number | null {
  const value = row.createTs;
  const digits = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  return EPOCH.test(digits) ? Number(digits.slice(0, 10)) : null;
}

/**
 * Whether a row's write time shows that its epoch is its instant: a row under a
 * country's code or without a place, written after its epoch but before the
 * earliest instant its Beijing wall clock stands for anywhere in that country, or
 * in the destination for a row without a place. A row is not written before it
 * happens, so its wall clock cannot be its place's.
 */
function writtenBeforeWallClock(row: Record<string, unknown>, clock: { seconds: number; wall: string }, location: string, destination: string): boolean {
  const written = writtenAt(row);
  if (written === null || written < clock.seconds - CLOCK_SLACK_S) return false;
  const earliest = earliestWallInstant(clock.wall, location, destination);
  return earliest !== null && written < earliest - CLOCK_SLACK_S;
}

/**
 * The earliest instant, in epoch seconds, a Beijing wall clock stands for in the country of a
 * row under a country's code, or in the destination for a row without a place or under a code
 * that names no country, as "EU"; null otherwise.
 */
function earliestWallInstant(wall: string, location: string, destination: string): number | null {
  const named = COUNTRY_CODE.test(location) ? countryZones(location) : [];
  const zones = named.length ? named : (!location || COUNTRY_CODE.test(location)) && destination ? countryZones(destination) : [];
  return zones.length ? Math.min(...zones.map((zone) => firstOccurrence(DateTime.fromISO(wall, { zone })).toSeconds())) : null;
}

/** A row read at its epoch, on the back office's clock. */
function onBackOffice(seconds: number): Pick<CarrierEvent, 'time' | 'time_zone' | 'time_zone_basis'> {
  return { time: DateTime.fromSeconds(seconds, { zone: BACK_OFFICE }).toISO({ suppressMilliseconds: true })!,
    time_zone: BACK_OFFICE, time_zone_basis: 'carrier' };
}

/** The facility or town a scan names, at most; anything that could be an address is dropped. */
function place(row: Record<string, unknown>): string {
  const name = withoutCountryCode(text(row, 'traceLocation', 120));
  return PLACE.test(name) ? name : '';
}

interface Parcel {
  status: string;
  country: string;
  events: CarrierEvent[];
  /** The newest scan's epoch seconds, or -Infinity without a scan. */
  newest: number;
}

/** One entry of the reply: its status, its destination and its scans, newest first, without rows that have no wording or time or repeat one. */
function readParcel(entry: Record<string, unknown>, order: Record<string, unknown>): Parcel {
  const status = text(order, 'traceStatus', 64);
  if (status && !STATUS.test(status)) throw new SchemaError(PROVIDER, 'Shouwu returned an invalid status');
  const country = text(order, 'countryCodeTwo', 8).toUpperCase();
  const destination = COUNTRY.test(country) ? country : '';
  const rows = entry.traces ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Shouwu returned a parcel with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Shouwu returned an oversized history');
  const seen = new Set<string>();
  const scans: { event: CarrierEvent; timestamp: number }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Shouwu returned an invalid scan');
    const clock = scanClock(row);
    const description = text(row, 'traceDesc');
    const location = place(row);
    // A row without wording or a time places nothing.
    if (!clock || !description) continue;
    const key = JSON.stringify([clock.seconds, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = shouwuStage(description);
    scans.push({ timestamp: clock.seconds, event: {
      local_time: clock.wall,
      ...(onEpoch(row, description, location) || writtenBeforeWallClock(row, clock, location, destination) ? onBackOffice(clock.seconds) : {}),
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  // Newest first; equal instants keep the reply's order, which lists the newest first.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((left, right) => right.timestamp - left.timestamp);
  // A wall clock that would land after a newer row read at its epoch, wherever in its country, is read at its
  // epoch too: customs written days late must not come after the round out for delivery.
  let bound = Infinity;
  for (const scan of scans) {
    const { event } = scan;
    if (event.time) {
      bound = Date.parse(event.time) / 1000;
      continue;
    }
    const earliest = earliestWallInstant(event.local_time!, event.location ?? '', destination);
    if (earliest !== null && earliest > bound) {
      Object.assign(event, onBackOffice(scan.timestamp));
      bound = scan.timestamp;
    }
  }
  // A delivery after a row that sent the parcel back, as DHL's to a business customer after its return to origin, is
  // the return delivered to the sender.
  let returning = false;
  for (const { event } of [...scans].reverse()) {
    if (shouwuSendsBack(event.description!) || (event.stage === 'returned' && event.stage_source === 'carrier_map')) returning = true;
    else if (returning && event.stage === 'delivered') Object.assign(event, { stage: 'returned', stage_source: 'carrier_map' });
  }
  return { status, country: destination, events: scans.map((scan) => scan.event), newest: scans[0]?.timestamp ?? -Infinity };
}

/**
 * The reply of the tracking page's `getOrderTrace` lookup:
 * `{"result":{"code":0},"data":[…]}` with one entry per parcel it has under
 * the numbers asked, and none for a number it does not have. Another code
 * is a failed lookup. An entry is `order`, with the number in `orderNo`, the
 * status code in `traceStatus` and the destination in `countryCodeTwo`, and
 * `traces`, each with epoch seconds in `traceTime`, wording in `traceDesc`
 * and a place in `traceLocation`, and its feed in `traceType`. A scan keeps the
 * wall clock its epoch shows in Beijing, for its place to date, unless its
 * epoch is its instant. Only entries naming the whole number asked are read,
 * and of them only those fields.
 */
export function parseShouwu(payload: unknown, raw: string): CarrierResult {
  const number = normalizeShouwuNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.result)) throw new SchemaError(PROVIDER, 'Shouwu returned an invalid reply');
  const outcome = payload.result.code;
  if (typeof outcome !== 'number' || !Number.isInteger(outcome)) throw new SchemaError(PROVIDER, 'Shouwu returned an invalid reply');
  // A failure, such as a request the tracker could not read, has another code and no data.
  if (outcome !== 0) throw new IndeterminateError(PROVIDER, 'Shouwu’s tracker did not complete the lookup');
  const entries = payload.data;
  if (!Array.isArray(entries)) throw new SchemaError(PROVIDER, 'Shouwu returned a reply without its parcels');
  if (entries.length > MAX_ENTRIES) throw new SchemaError(PROVIDER, 'Shouwu returned an oversized reply');

  let found: Parcel | undefined;
  let others = 0;
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.order) || typeof entry.order.orderNo !== 'string') {
      throw new SchemaError(PROVIDER, 'Shouwu returned an invalid parcel');
    }
    if (normalizeTrackingNumber(entry.order.orderNo) !== number) {
      others += 1;
      continue;
    }
    // The page lists every entry under a number; the one with the newest scan is the parcel.
    const parcel = readParcel(entry, entry.order);
    if (!found || parcel.newest > found.newest) found = parcel;
  }
  if (!found) {
    if (others) throw new IndeterminateError(PROVIDER, 'Shouwu answered for another number');
    // The page reads a number missing from the reply as not found.
    throw new NotFoundError(PROVIDER, 'Shouwu International has no parcel under this number');
  }

  const { status: code, country, events } = found;
  const summary = code ? shouwuStatusStage(code) : undefined;
  // A record of the booking logged after the parcel moved is no step back.
  const scanned = events.find((event) => event.stage && event.stage !== 'registered') ?? events.find((event) => event.stage);
  // The tracker's status decides, as on the page; a scan refines it within what the status covers, and
  // a status the map does not know leaves the newest staged scan.
  // In Transit on the order data alone rests on the row Shouwu writes two hours after it, before
  // anyone has the parcel, so the order data's stage stands.
  const ordered = summary === 'in_transit' && events.every((event) => event.stage === 'registered');
  const refined = summary && scanned && (ordered || REFINES[summary]?.has(scanned.stage!)) ? scanned : undefined;
  const stage = (refined?.stage ?? summary ?? scanned?.stage) as Stage | undefined;
  const source = refined?.stage_source ?? (summary ? 'carrier_map' : scanned?.stage_source);
  const destination = country ? { destination_country: country } : {};
  if (!events.length) {
    if (!summary) throw new NoHistoryError(PROVIDER);
    // A parcel can have its status before its first scan.
    return {
      status: languageStageStatus(summary),
      current_stage: summary,
      current_stage_source: 'carrier_map',
      provider_code: code,
      last_status_text: shouwuStatusLabel(code) ?? null,
      last_update: null,
      expected_delivery: null,
      ...destination,
      summary_only: true,
      events: [],
    };
  }
  const newest = events[0]!;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    ...destination,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
