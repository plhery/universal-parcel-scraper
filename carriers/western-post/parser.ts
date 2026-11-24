import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { statusMap, westernPostStage } from './status.js';

export const PROVIDER = 'Western Post';
export const CARRIER = 'western-post';
// A parcel with seven scans is about 1.5 kB.
export const WESTERN_POST_MAX_BYTES = 256 * 1024;

// WP and thirteen digits on the public sample; the tracking box takes any number it is given.
const NUMBER = /^[A-Z0-9]{6,40}$/;
// "2026-07-15 13:49:03": a wall clock with no zone, to the second.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/;
// A scan code, such as DD or OD.
const CODE = /^[A-Z0-9_]{1,12}$/;
// The reply's address column holds the scan's town. One with a digit could be a street address
// or a postcode, so it is dropped.
const DIGIT = /\d/;
// Who signed for the parcel, should a delivery's wording go on to name them.
const SIGNER = /\s*[,;:–-]?\s*(?:\b(?:signed (?:for )?by|signatory)\b|签收人).*$/i;
// A firewall's, CDN's or bot check's page in place of the tracker's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha|安全验证|访问被拒绝/i;
const MAX_ROWS = 300;
const POUNDS_TO_KG = 0.45359237;

/** A number for Western Post's tracker: letters and digits, in capitals. */
export function normalizeWesternPostNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Western Post looks parcels up by 6 to 40 letters and digits');
  return number;
}

/** Whether a reply is a block page instead of the tracker's JSON. */
export function isWesternPostBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A text field, which the reply writes as a string or null. */
function text(value: unknown, max: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > max) return invalid('Western Post returned an invalid field');
  return clean(value, max);
}

/** A list the reply may leave out or write as null. */
function rows(value: unknown, what: string): unknown[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ROWS) return invalid(`Western Post returned an invalid ${what}`);
  return value;
}

/** The number a row belongs to, as the reply writes it on every row. */
function owner(row: unknown): string {
  if (!isRecord(row) || typeof row.trackingNumber !== 'string' || row.trackingNumber.length > 64) {
    return invalid('Western Post returned a row without its number');
  }
  return normalizeTrackingNumber(row.trackingNumber).toUpperCase();
}

/** A scan's date and time as one wall time, calendar-checked. The reply names no zone. */
function wallClock(value: unknown): string {
  const parts = CLOCK.exec(text(value, 40));
  const day = parts && calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3]));
  if (!parts || !day || Number(parts[1]) < 2000 || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6] ?? 0) > 59) {
    return invalid('Western Post returned an invalid scan time');
  }
  return `${day}T${parts[4]}:${parts[5]}:${parts[6] ?? '00'}`;
}

/** A scan: its code, its English wording without whoever signed for the parcel, its town and its wall clock. */
function scan(row: Record<string, unknown>, withPlace: boolean): CarrierEvent {
  const code = text(row.nodeCode, 12).toUpperCase();
  if (code && !CODE.test(code)) return invalid('Western Post returned an invalid scan code');
  const description = text(row.remarks, 500).replace(SIGNER, '').trim() || invalid('Western Post returned a scan without its wording');
  const place = withPlace ? text(row.trackAddress, 120) : '';
  const staged = westernPostStage(code || null, description);
  return {
    local_time: wallClock(row.trackTime),
    ...(place && !DIGIT.test(place) ? { location: place } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** Newest first, as the tracker lists them; an oldest-first list is turned round, ties kept in its order. */
function newestFirst(events: CarrierEvent[]): CarrierEvent[] {
  return events.length > 1 && (events[0]!.local_time as string) < (events.at(-1)!.local_time as string) ? events.reverse() : events;
}

/** A positive measure the reply writes as a decimal string, such as "115.081". */
function measure(value: unknown): number | null {
  const raw = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  const amount = /^\d{1,6}(?:\.\d{1,4})?$/.test(raw) ? Number(raw) : 0;
  return amount > 0 ? amount : null;
}

/** The parcel's weight in kilograms and its sides, in the units the reply names; anything else is not read. */
function sizeAndWeight(row: Record<string, unknown> | undefined): Pick<CarrierResult, 'weight_kg' | 'dimensions_text'> {
  if (!row) return {};
  const weight = measure(row.ordersWeight);
  const weightUnit = typeof row.weightUnit === 'string' ? row.weightUnit.trim().toUpperCase() : '';
  const kilograms = weight === null ? null : weightUnit === 'LB' ? weight * POUNDS_TO_KG : weightUnit === 'KG' ? weight : null;
  const sides = [row.ordersLength, row.ordersWidth, row.ordersHeight].map(measure);
  const sizeUnit = typeof row.sizeUnit === 'string' ? row.sizeUnit.trim().toLowerCase() : '';
  return {
    ...(kilograms === null ? {} : { weight_kg: Math.round(kilograms * 1000) / 1000 }),
    ...(['in', 'cm'].includes(sizeUnit) && sides.every((side) => side !== null) ? { dimensions_text: `${sides.join(' × ')} ${sizeUnit}` } : {}),
  };
}

/**
 * The reply of `www.wpglb.com/trackQuery` for one number, the lookup the
 * tracking box on Western Post's home page makes. Its `data` holds the scans of
 * every number asked in one list, each scan naming its number, with a code, an
 * English wording, a town and a wall clock to the second, newest first; then the
 * delivery photos the page shows only for the signer's name, the sender's and
 * recipient's towns, and the parcel's size and weight, each row naming its
 * number too. A number the tracker holds nothing for gets every list empty.
 *
 * Only the asked number's rows are read. The photos and the towns of the sender
 * and recipient, which the page does not show, are never read.
 */
export function parseWesternPost(payload: unknown, raw: string): CarrierResult {
  const number = normalizeWesternPostNumber(raw);
  if (!isRecord(payload)) return invalid('Western Post returned an unexpected reply');
  if (payload.code !== 200 || payload.success !== true) {
    // The page shows the message of a refused lookup; it says nothing about the number.
    if (typeof payload.code === 'number' || typeof payload.success === 'boolean') {
      throw new IndeterminateError(PROVIDER, 'Western Post did not complete the lookup');
    }
    return invalid('Western Post returned an unexpected reply');
  }
  const data = payload.data;
  if (!isRecord(data) || !Array.isArray(data.list)) return invalid('Western Post returned an unexpected reply');
  const scans = rows(data.list, 'history');
  if (data.trackAddress !== undefined && data.trackAddress !== null && !isRecord(data.trackAddress)) return invalid('Western Post returned invalid towns');
  const addresses = isRecord(data.trackAddress) ? data.trackAddress : {};
  const sizes = rows(data.sizeAndWeight, 'size list');
  const others = [
    ...rows(data.trackFiles, 'photo list'), ...sizes, ...rows(addresses.senderInfo, 'sender town'), ...rows(addresses.receiverInfo, 'recipient town'),
  ];
  const mine = scans.filter((row) => owner(row) === number) as Record<string, unknown>[];
  const named = [...scans, ...others].map(owner);
  if (!mine.length) {
    // The reply repeats no number when it holds nothing: the stateless lookup of one number binds it.
    if (!named.length) throw new NotFoundError(PROVIDER);
    if (named.includes(number)) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });
    throw new IndeterminateError(PROVIDER, 'Western Post answered for another number');
  }
  // The page shows the town column only for this type of reply.
  const events = newestFirst(mine.map((row) => scan(row, data.type === 1)));
  const newest = events[0]!;
  const measured = sizes.find((row) => owner(row) === number) as Record<string, unknown> | undefined;
  // The newest scan with a stage leads; a newer one without a stage may have undone a delivery.
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    ...sizeAndWeight(measured),
    events,
  };
}

/** The tracker's reply as JSON, or the reason it is not one. */
export function westernPostJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (isWesternPostBlocked(body)) throw new ChallengeError(PROVIDER, 'Western Post answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Western Post returned a reply that is not JSON', { cause });
  }
}
