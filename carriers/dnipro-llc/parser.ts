import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { dniproEventStage, statusMap } from './status.js';

export const PROVIDER = 'dnipro-llc';
/** The lookup Dnipro LLC's tracking page posts `{"number", "language", "fingerprint"}` to. */
export const DNIPRO_LOOKUP = 'https://dniprollc.com/wp-json/dnipro-tracking/v1/lookup';
// A parcel's reply with one event is about 400 bytes.
export const DNIPRO_MAX_BYTES = 512 * 1024;

// The tracking page's own check is 3 to 80 letters, digits and separators. Parcel numbers are
// letters and digits; separators are dropped and every number has a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// A firewall's, CDN's or bot check's page in place of the lookup's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden|Verifying)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha|imunify/i;
// "2026-05-22 09:57:32": the event's wall clock, without a zone.
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const MAX_EVENTS = 300;

/** A number for Dnipro LLC's tracker, in capitals and without separators. */
export function normalizeDniproNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Dnipro LLC tracks numbers of 6 to 40 letters and digits');
  return number;
}

/** Whether a reply is a block page instead of the lookup's JSON. */
export function isDniproBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A text field, or nothing; anything but a string or null is a changed reply. */
function text(value: unknown, max: number, what: string): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? clean(value, max) : invalid(`Dnipro LLC returned an invalid ${what}`);
}

/** An event's wall clock. It carries no zone and the parcel crosses several, so it stays one. */
function clockOf(value: unknown): string {
  const wall = WALL_CLOCK.exec(typeof value === 'string' ? value.trim() : '');
  const day = wall ? calendarDay(Number(wall[1]), Number(wall[2]), Number(wall[3])) : null;
  if (!wall || !day || Number(wall[1]) < 2000) return invalid('Dnipro LLC returned an event without its time');
  return `${day}T${wall[4]}:${wall[5]}:${wall[6] ?? '00'}`;
}

/**
 * One event: its code, its message, its wall clock and its town. The postcode is never read: a
 * delivery's gives the recipient's address.
 */
function eventOf(row: unknown): CarrierEvent {
  if (!isRecord(row)) return invalid('Dnipro LLC returned an invalid event');
  const code = row.code === null || row.code === undefined ? null
    : typeof row.code === 'number' && Number.isSafeInteger(row.code) && row.code >= 0 ? String(row.code)
      : typeof row.code === 'string' && /^\d{1,6}$/.test(row.code.trim()) ? row.code.trim() : invalid('Dnipro LLC returned an invalid event code');
  const description = text(row.message, 200, 'event') || invalid('Dnipro LLC returned an event without its message');
  const location = text(row.city, 80, 'event place');
  const staged = dniproEventStage(code, description);
  return {
    local_time: clockOf(row.date),
    description,
    ...(location ? { location } : {}),
    ...(code === null ? {} : { provider_code: code }),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The lookup's refusal: a JSON `code` such as the page's `rate_limited` or `invalid_number`. */
export function dniproRefusal(payload: unknown, status: number): never {
  const code = isRecord(payload) && typeof payload.code === 'string' ? payload.code : '';
  if (code === 'rate_limited' || status === 429) throw new RateLimitedError(PROVIDER);
  if (code === 'invalid_number') throw new InvalidInputError(PROVIDER, 'Dnipro LLC does not take this number');
  throw new IndeterminateError(PROVIDER, 'Dnipro LLC did not complete the lookup', { status });
}

/**
 * The reply of `POST dniprollc.com/wp-json/dnipro-tracking/v1/lookup`, the lookup Dnipro LLC's
 * tracking page makes: `items`, one per parcel under the number, each with its transport, origin,
 * destination, container and events, newest first. An empty list is the page's "Parcel not
 * found".
 *
 * The transport, the origin, the destination (whose name the page shows as the recipient's), the
 * postcodes and the container, line, voyage and booking are never read.
 */
export function parseDnipro(payload: unknown, raw: string): CarrierResult {
  const number = normalizeDniproNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.items)) return invalid('Dnipro LLC returned an unexpected reply');
  if (payload.items.length === 0) throw new NotFoundError(PROVIDER, 'Dnipro LLC has no parcel under this number');
  // The item must name the number asked; the lookup echoes the number as typed.
  const items = payload.items.filter((item) => isRecord(item) && typeof item.number === 'string'
    && normalizeTrackingNumber(item.number).toUpperCase() === number) as Record<string, unknown>[];
  if (items.length === 0) throw new IndeterminateError(PROVIDER, 'Dnipro LLC answered for another parcel');
  if (items.length > 1) throw new IndeterminateError(PROVIDER, 'Dnipro LLC holds several parcels under this number');
  const item = items[0]!;
  if (!Array.isArray(item.events)) return invalid('Dnipro LLC returned a parcel without its events');
  if (item.events.length > MAX_EVENTS) return invalid('Dnipro LLC returned too many events');
  const events = item.events.map(eventOf);
  const newest = events[0];
  // The page shows "No tracking events yet" for such a parcel.
  if (!newest) throw new NoHistoryError(PROVIDER, 'Dnipro LLC lists the parcel without events', { reason: 'listed' });
  // The newest event with a stage leads.
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    events,
  };
}

/** The lookup's reply as JSON, or the reason it is not one. */
export function dniproJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (isDniproBlocked(body)) throw new ChallengeError(PROVIDER, 'Dnipro LLC answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Dnipro LLC returned a reply that is not JSON', { cause });
  }
}
