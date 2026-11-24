import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { coshipEventStage, statusMap } from './status.js';

export const PROVIDER = 'coship';
/** The lookup COSHIP's tracking page reads, with the number as the last path segment. */
export const COSHIP_LOOKUP = 'https://www.coship.ca/api/tracking/';
// A parcel with a dozen rows is under 2 kB.
export const COSHIP_MAX_BYTES = 256 * 1024;

// The numbers seen are thirteen digits; the page takes any text. Every number has a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// The page answers its ocean shipments' numbers itself, without asking the tracker.
const OCEAN = /^COS/;
// A firewall's, CDN's or bot check's page in place of the tracker's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
// "2021-02-01" or "2025-11-20 10:05": the row's day, or its wall clock, without a zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?)?$/;
// The row's code, such as 00.
const CODE = /^[A-Z0-9]{1,8}$/;
// What a Korea Post delivery row says after its step: who took the parcel, or the postman's name.
const RECIPIENT = /\s*\((?:수령인|수취인|받는\s*분)[^)]*\)?/g;
const POSTMAN = /\s*집배원.*$/;
const MAX_PARCELS = 20;
const MAX_ROWS = 300;

/** A number for COSHIP's tracker: letters and digits with at least one digit, in capitals. */
export function normalizeCoshipNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'COSHIP tracks numbers of 6 to 30 letters and digits');
  return number;
}

/** Whether COSHIP gives the number to an ocean shipment, which its page says it does not track. */
export function isCoshipOceanNumber(number: string): boolean {
  return OCEAN.test(number);
}

/** Whether a reply is a block page instead of the tracker's JSON. */
export function isCoshipBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A text field, or nothing; anything but a string, a number or null is a changed reply. */
function text(value: unknown, max: number, what: string): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? clean(value, max) : invalid(`COSHIP returned an invalid ${what}`);
}

/** A row's day, or its wall clock, calendar-checked. The reply and the page name no zone. */
function clockOf(value: unknown): string {
  const parts = CLOCK.exec(text(value, 40, 'row time'));
  const day = parts && calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3]));
  if (!parts || !day || Number(parts[1]) < 2000) return invalid('COSHIP returned an invalid row time');
  return parts[4] ? `${day}T${parts[4]}:${parts[5]}:${parts[6] ?? '00'}` : day;
}

/**
 * A row's step as the page shows it: its first line, without the Korea Post delivery's
 * "(배달)" and without who took the parcel or the postman's name.
 */
function stepOf(value: unknown): string {
  if (value !== null && value !== undefined && typeof value !== 'string') return invalid('COSHIP returned an invalid row');
  const first = (value ?? '').trim().split('\n')[0] ?? '';
  return clean(clean(first, 400).replace(RECIPIENT, '').replace(POSTMAN, '').replace(/\s*\(배달\)\s*$/, ''), 200);
}

/**
 * One row: its code, its step, its place and its day or wall clock. The memo and the service
 * notes are never read.
 */
function rowOf(row: unknown): CarrierEvent | null {
  if (!isRecord(row)) return invalid('COSHIP returned an invalid row');
  const description = stepOf(row.statusNm);
  // The page leaves out a row with neither a step nor a time.
  if (!description && !text(row.stepDt, 40, 'row time')) return null;
  if (!description) return invalid('COSHIP returned a row without its step');
  const raw = text(row.statusCd, 20, 'row code').toUpperCase();
  const code = raw === '' ? null : CODE.test(raw) ? raw : invalid('COSHIP returned an invalid row code');
  // The page's place: the row's location, else the post office that scanned it.
  const location = text(row.locationNm, 120, 'row place') || text(row.ProcessStoreName, 120, 'row place');
  const staged = coshipEventStage(code, description);
  return {
    local_time: clockOf(row.stepDt),
    description,
    ...(location && location !== '-' ? { location } : {}),
    ...(code === null ? {} : { provider_code: code }),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** Newest first; the tracker lists them oldest first. Rows of one day or minute keep their order, turned round. */
function newestFirst(events: CarrierEvent[]): CarrierEvent[] {
  return events.reverse().sort((a, b) => (a.local_time! < b.local_time! ? 1 : a.local_time! > b.local_time! ? -1 : 0));
}

/** Whether a record is the tracker's blank one, its answer for a number it does not hold. */
function blank(parcel: Record<string, unknown>): boolean {
  return !text(parcel.hawbno, 64, 'number') && (parcel.details === null || parcel.details === undefined
    || (Array.isArray(parcel.details) && parcel.details.length === 0));
}

/**
 * The reply of `GET www.coship.ca/api/tracking/<number>`, the lookup COSHIP's tracking page
 * makes: `resultJson.mArray`, one record per parcel, naming its waybill (`hawbno`) and its rows,
 * oldest first, each with a code, a step, a day or wall clock and a place. COSHIP's own rows
 * cover its warehouse, the flight and the arrival; for parcels to Korea, Korean customs' and
 * Korea Post's rows follow. A number it holds nothing under gets one blank record.
 *
 * The recipient's name and address, the contents, the item count, the merchant's order number,
 * the memo and the service notes are never read.
 */
export function parseCoship(payload: unknown, raw: string): CarrierResult {
  const number = normalizeCoshipNumber(raw);
  const result = isRecord(payload) ? payload.resultJson : undefined;
  if (!isRecord(result) || !Array.isArray(result.mArray)) return invalid('COSHIP returned an unexpected reply');
  const parcels = result.mArray as unknown[];
  if (!parcels.length) return invalid('COSHIP returned an empty parcel list');
  if (parcels.length > MAX_PARCELS) return invalid('COSHIP returned too many parcels');
  if (!parcels.every(isRecord)) return invalid('COSHIP returned an invalid parcel');
  const records = parcels as Record<string, unknown>[];
  // The tracker's own answer for a number it holds nothing under: a blank record. It does not
  // repeat the number; the request for it does.
  if (records.every(blank)) throw new NotFoundError(PROVIDER, 'COSHIP has no shipment under this number');
  // The reply must name the number asked, as the waybill.
  const parcel = records.find((entry) => normalizeTrackingNumber(text(entry.hawbno, 64, 'number')).toUpperCase() === number);
  if (!parcel) throw new IndeterminateError(PROVIDER, 'COSHIP answered for another shipment');
  if (parcel.details !== null && parcel.details !== undefined && !Array.isArray(parcel.details)) return invalid('COSHIP returned an invalid history');
  const rows = (parcel.details ?? []) as unknown[];
  if (rows.length > MAX_ROWS) return invalid('COSHIP returned too many rows');
  const events = newestFirst(rows.map(rowOf).filter((event): event is CarrierEvent => event !== null));
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER, 'COSHIP lists the shipment without rows', { reason: 'listed' });
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

/** The tracker's reply as JSON, or the reason it is not one. */
export function coshipJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (isCoshipBlocked(body)) throw new ChallengeError(PROVIDER, 'COSHIP answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'COSHIP returned a reply that is not JSON', { cause });
  }
}
