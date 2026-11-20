import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { matsonStage } from './status.js';

export const PROVIDER = 'Matson';
export const MATSON_ORIGIN = 'https://www.matson.com';
/** The shipment tracking page, whose form carries the token the lookup asks for. */
export const MATSON_PAGE = `${MATSON_ORIGIN}/shipment-tracking.html`;
/** The lookup the page's script posts the number to. */
export const MATSON_LOOKUP = `${MATSON_ORIGIN}/wp-content/plugins/matson-plugin/Api_calls/tracking_booking_proxy.php`;
export const MATSON_PAGE_MAX_BYTES = 1024 * 1024;
export const MATSON_REPLY_MAX_BYTES = 1024 * 1024;

/**
 * The clock the page reads every date of a reply on. A scan's date is its place's wall clock
 * written as if on this clock: rendered on it, the page shows the time the place recorded.
 */
const PAGE_ZONE = 'America/Los_Angeles';
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)|captcha-delivery\.com|verify (?:that )?you are human/i;
const MAX_CONTAINERS = 200;
const MAX_ROWS = 500;
const MAX_EVENTS = 200;
const TOKEN = /^[0-9a-z]{6,64}$/i;
// Fall 2001 to 2100: a date outside is no scan's.
const EARLIEST = 1_000_000_000_000;
const LATEST = 4_102_444_800_000;

/** What the tracking form asks for: a container by its ISO 6346 number, a booking, or a bill of lading. */
export type MatsonQuery =
  | { kind: 'container'; number: string; trackingVal: 'tckconta' }
  | { kind: 'booking'; number: string; booking: string; trackingVal: 'tckbok' }
  | { kind: 'bill'; number: string; booking: string; trackingVal: 'tckbil' };

// Letters count from 10 and skip the multiples of 11: A is 10, B 12, L 23, Z 38.
const LETTER_VALUES = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter, index) => [letter, 10 + index + Math.floor((index + 9) / 10)]));

/** The ISO 6346 check digit of a container's owner code, category and serial number. */
export function containerCheckDigit(body: string): number {
  if (!/^[A-Z]{3}[UJZ]\d{6}$/.test(body)) throw new InvalidInputError(PROVIDER, 'Container numbers are an owner code, a category letter and six digits');
  const sum = [...body].reduce((total, character, index) => total + (LETTER_VALUES.get(character) ?? Number(character)) * 2 ** index, 0);
  return sum % 11 % 10;
}

/**
 * The query for a Matson number: a container's whole ISO 6346 number with its check digit, a
 * seven-digit booking number, or a bill of lading, `MATS` and the booking number with three more digits.
 */
export function matsonQuery(raw: string): MatsonQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (/^[A-Z]{3}[UJZ]\d{7}$/.test(number)) {
    if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
    return { kind: 'container', number, trackingVal: 'tckconta' };
  }
  if (/^\d{7}$/.test(number)) return { kind: 'booking', number, booking: number, trackingVal: 'tckbok' };
  if (/^MATS\d{10}$/.test(number)) return { kind: 'bill', number, booking: number.slice(4, 11), trackingVal: 'tckbil' };
  throw new InvalidInputError(PROVIDER, 'Matson tracks a container number, a seven-digit booking number or a MATS bill of lading');
}

/** A page a challenge, rather than the tracker, answered. */
function assertNotBlocked(body: string): void {
  if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Matson requires browser verification');
}

/** The token the tracking page's form carries, which the lookup must send back. */
export function matsonToken(html: string): string {
  assertNotBlocked(html);
  const fields = load(html)('input#ttr');
  const token = fields.length === 1 ? fields.attr('value')?.trim() ?? '' : '';
  if (!TOKEN.test(token)) throw new SchemaError(PROVIDER, 'Matson tracking page changed');
  return token;
}

const text = (record: Record<string, unknown>, key: string, maxLength = 200): string => {
  const value = record[key];
  if (value !== null && value !== undefined && typeof value !== 'string') throw new SchemaError(PROVIDER, `Matson returned an invalid ${key}`);
  return clean(value, maxLength);
};

/** A date of the reply, as the wall clock the page shows for it. */
function wallClock(value: unknown): string {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < EARLIEST || value > LATEST) throw new SchemaError(PROVIDER, 'Matson returned an invalid date');
  return DateTime.fromMillis(value, { zone: PAGE_ZONE }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

interface Container {
  readonly number: string;
  readonly events: readonly CarrierEvent[];
}

function container(record: Record<string, unknown>): Container {
  const owner = text(record, 'containerNumber', 20);
  const digit = text(record, 'checkDigit', 2);
  if (!/^[A-Z]{4}\d{6}$/.test(owner) || !/^\d$/.test(digit)) throw new SchemaError(PROVIDER, 'Matson returned a container without its number');
  const rows = record.events;
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Matson returned invalid container events');
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Matson returned an invalid container event');
    // The page lists an event without a date with no time; it cannot be placed among the others.
    if (row.date === null) continue;
    const status = text(row, 'status', 300);
    if (!status) throw new SchemaError(PROVIDER, 'Matson returned an event without its status');
    // The event's name, padded to a column, then what Matson adds to it: a vessel, a trucker, a hold's reason.
    const code = (typeof row.status === 'string' ? row.status.trim().split(/\s{2,}/)[0] ?? '' : '').replace(/\s+/g, ' ');
    const location = text(row, 'location');
    const stage = matsonStage(code, status);
    events.push({ local_time: wallClock(row.date), ...(location ? { location } : {}), description: status, provider_code: code,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }
  return { number: `${owner}${digit}`, events };
}

/** The one name the containers' records agree on, if any. */
function party(records: readonly Record<string, unknown>[], key: string): string | undefined {
  const names = new Set(records.map(record => text(record, key)).filter(Boolean));
  return names.size === 1 ? [...names][0] : undefined;
}

const newestFirst = (left: { event: CarrierEvent; order: number }, right: { event: CarrierEvent; order: number }) =>
  left.event.local_time! < right.event.local_time! ? 1 : left.event.local_time! > right.event.local_time! ? -1 : left.order - right.order;

/**
 * The scan whose stage the shipment is at. A booking's containers move apart: one returned
 * empty from the consignee does not make the others delivered, so a delivery decides only once
 * every container has one.
 */
function currentScan(containers: readonly Container[]): CarrierEvent | undefined {
  const latest = containers.map(item => item.events.find(event => event.stage));
  const open = latest.filter(event => event?.stage !== 'delivered');
  const candidates = (open.length ? open : latest).filter((event): event is CarrierEvent => event !== undefined);
  return candidates.map((event, order) => ({ event, order })).sort(newestFirst)[0]?.event;
}

/**
 * Matson's reply to a lookup: one container's record for a container number, a list of the
 * booking's containers for a booking or bill of lading, and an empty list for a number it does
 * not hold. Each record lists its events newest first.
 */
export function parseMatsonReply(body: string, query: MatsonQuery): CarrierResult {
  assertNotBlocked(body);
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'Matson returned a reply that is not JSON', { cause });
  }
  if (Array.isArray(reply) && !reply.length) throw new NotFoundError(PROVIDER, 'Matson does not hold this number');
  // A container's lookup answers a record; the page reads one without a booking as no shipment.
  if (query.kind === 'container' && isRecord(reply) && reply.bookingNumber === null) throw new NotFoundError(PROVIDER, 'Matson does not hold this number');
  const records = query.kind === 'container' ? [reply] : reply;
  if (!Array.isArray(records) || records.length > MAX_CONTAINERS || !records.every(isRecord)) throw new SchemaError(PROVIDER, 'Matson returned an invalid reply');

  const containers = records.map(container);
  if (query.kind === 'container') {
    // Matson finds the container by its first ten characters whatever its check digit: the whole number must match.
    if (containers[0]!.number !== query.number) throw new SchemaError(PROVIDER, 'Matson returned another container');
    if (text(records[0]!, 'bookingNumber', 20) === '') throw new SchemaError(PROVIDER, 'Matson returned a container without its booking');
  } else if (records.some(record => text(record, 'bookingNumber', 20) !== query.booking)) {
    throw new SchemaError(PROVIDER, 'Matson returned another booking');
  }

  const seen = new Set<string>();
  const events = containers.flatMap((item, index) => item.events.map((event, row) => ({ event, order: index * MAX_ROWS + row })))
    .sort(newestFirst)
    // A booking's containers share their vessel's moves: each is kept once.
    .filter(({ event }) => {
      const key = JSON.stringify([event.local_time, event.location ?? '', event.description]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ event }) => event);
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Matson lists the shipment without events', { reason: 'listed' });

  const newest = events[0]!;
  const current = currentScan(containers);
  const stage = current?.stage as Stage | undefined;
  const sender = party(records, 'shipperName');
  const receiver = party(records, 'consigneeName');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current ? { current_stage: stage, current_stage_source: current.stage_source } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, expected_delivery: null,
    ...(sender ? { sender_name: sender } : {}), ...(receiver ? { receiver_name: receiver } : {}),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}), events: events.slice(0, MAX_EVENTS),
  };
}
