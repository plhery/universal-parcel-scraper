import { carrierIdFromName } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { comoneEventStage, comoneProgress, statusMap } from './status.js';

export const PROVIDER = 'comone-express';
/** The lookup ComOne's tracking page posts `number=<number>` to, as a form, path as the page writes it. */
export const COMONE_LOOKUP = 'https://service.com1logistics.com//pod/track/query';
// A parcel with nineteen scans is about 19 kB.
export const COMONE_MAX_BYTES = 512 * 1024;

// ComOne's waybills seen are nine digits; the tracker takes other references too. Every number has a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
const REFERENCE = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// A firewall's, CDN's or bot check's page in place of the tracker's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
// "2026-04-29 13:36:13": the scan's wall clock, without a zone.
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
// The scan's code, such as SD or OFD.
const CODE = /^[A-Z][A-Z0-9_]{0,15}$/;
// A refusal that asks the visitor to slow down.
const THROTTLED = /too many|too frequent|rate limit|频繁|稍后/i;
const MAX_PARCELS = 20;
const MAX_SCANS = 300;

/** A number for ComOne's tracker: letters and digits with at least one digit, in capitals. */
export function normalizeComoneNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'ComOne Express tracks numbers of 6 to 40 letters and digits');
  return number;
}

/** Whether a reply is a block page instead of the tracker's JSON. */
export function isComoneBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A text field, or nothing; anything but a string or null is a changed reply. */
function text(value: unknown, max: number, what: string): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? clean(value, max) : invalid(`ComOne Express returned an invalid ${what}`);
}

/** A scan's wall clock, calendar-checked. The reply and the page name no zone. */
function wallClock(value: unknown): string {
  const parts = WALL_CLOCK.exec(text(value, 40, 'scan time'));
  const day = parts && calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3]));
  if (!parts || !day || Number(parts[1]) < 2000) return invalid('ComOne Express returned an invalid scan time');
  return `${day}T${parts[4]}:${parts[5]}:${parts[6] ?? '00'}`;
}

/**
 * One scan: its code, its English wording (the Chinese one when it has none), its place and
 * its wall clock. The remark, which can name the driver, and the delivery photos and signature
 * are never read.
 */
function scan(row: unknown): CarrierEvent {
  if (!isRecord(row)) return invalid('ComOne Express returned an invalid scan');
  const description = text(row.traceEventEn, 200, 'scan') || text(row.traceEventCn, 200, 'scan')
    || invalid('ComOne Express returned a scan without its wording');
  const raw = text(row.podStatusCode, 20, 'scan code').toUpperCase();
  const code = raw === '' ? null : CODE.test(raw) ? raw : invalid('ComOne Express returned an invalid scan code');
  const location = text(row.traceLocation, 120, 'scan place');
  const staged = comoneEventStage(code, description);
  return {
    local_time: wallClock(row.traceTime || row.traceTimeFormat),
    description,
    ...(location ? { location } : {}),
    ...(code === null ? {} : { provider_code: code }),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** Newest first, as the tracker lists them; an oldest-first list is turned round, ties kept in its order. */
function newestFirst(events: CarrierEvent[]): CarrierEvent[] {
  return events.length > 1 && (events[0]!.local_time as string) < (events.at(-1)!.local_time as string) ? events.reverse() : events;
}

/**
 * The carrier ComOne hands the parcel to, from the parcel's supplier: named only when its name
 * is one catalog carrier's and that carrier's rules fit the number it tracks the parcel under,
 * the supplier's own number, else the one asked.
 */
function handoff(parcel: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const name = text(parcel.supplierName, 80, 'supplier');
  const partner = name ? carrierIdFromName(name) : undefined;
  if (!partner || partner === PROVIDER) return {};
  const reference = normalizeTrackingNumber(text(parcel.supplierTrackingNo, 64, 'supplier number')).toUpperCase() || number;
  if (!REFERENCE.test(reference) || !(detectCarrierMatch(reference).candidates as readonly string[]).includes(partner)) return {};
  return { delivery_carrier: partner, ...(reference === number ? {} : { delivery_tracking_number: reference }) };
}

/** Whether a parcel's record names the number asked, as its waybill. */
function names(parcel: unknown, number: string): parcel is Record<string, unknown> {
  if (!isRecord(parcel)) return invalid('ComOne Express returned an invalid parcel');
  if (typeof parcel.expressNo !== 'string') return invalid('ComOne Express returned a parcel without its number');
  return [parcel.expressNo, parcel.number].some((value) => typeof value === 'string' && normalizeTrackingNumber(value).toUpperCase() === number);
}

/**
 * The reply of `POST service.com1logistics.com//pod/track/query`, the lookup ComOne's tracking
 * page makes for each number. `code` 0 with a `data` list of the parcels it holds under the
 * number: each names its waybill, its status code, its destination country, the supplier that
 * delivers it and its scans, newest first, each with a code, an English and a Chinese wording,
 * a place and a wall clock. A number it holds no parcel under gets the same answer with an
 * empty list.
 *
 * The merchant's order number, the weights, the remarks, which can name the driver, and the
 * delivery photos and signature are never read.
 */
export function parseComone(payload: unknown, raw: string): CarrierResult {
  const number = normalizeComoneNumber(raw);
  if (!isRecord(payload) || typeof payload.code !== 'number' || typeof payload.success !== 'boolean') {
    return invalid('ComOne Express returned an unexpected reply');
  }
  if (payload.code !== 0 || !payload.success) {
    if (payload.code === 429 || THROTTLED.test(text(payload.msg, 300, 'message'))) throw new RateLimitedError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'ComOne Express did not complete the lookup');
  }
  if (!Array.isArray(payload.data)) return invalid('ComOne Express returned an invalid parcel list');
  // The tracker's own answer for a number it holds no parcel under. It does not repeat the
  // number; the request for it does.
  if (!payload.data.length) throw new NotFoundError(PROVIDER, 'ComOne Express has no parcel under this number');
  if (payload.data.length > MAX_PARCELS) return invalid('ComOne Express returned too many parcels');
  // The reply must name the number asked.
  const parcel = (payload.data as unknown[]).find((entry) => names(entry, number));
  if (!parcel) throw new IndeterminateError(PROVIDER, 'ComOne Express answered for another parcel');
  if (parcel.traces !== null && parcel.traces !== undefined && !Array.isArray(parcel.traces)) return invalid('ComOne Express returned an invalid history');
  const rows = (parcel.traces ?? []) as unknown[];
  if (rows.length > MAX_SCANS) return invalid('ComOne Express returned too many scans');
  if (parcel.statusCode !== null && parcel.statusCode !== undefined && !Number.isSafeInteger(parcel.statusCode)) {
    return invalid('ComOne Express returned an invalid status');
  }
  const country = text(parcel.desCountryId, 8, 'destination').toUpperCase();
  const facts = {
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    ...handoff(parcel, number),
  };
  const progress = typeof parcel.statusCode === 'number' ? comoneProgress(parcel.statusCode) : undefined;
  const events = newestFirst(rows.map(scan));
  const newest = events[0];
  if (!newest) {
    // A parcel without scans stands on the step the page shows for its status, when it names one.
    if (!progress) {
      throw new NoHistoryError(PROVIDER, 'ComOne Express lists the parcel without scans', {
        reason: 'listed', deliveryCarrier: facts.delivery_carrier, deliveryTrackingNumber: facts.delivery_tracking_number,
      });
    }
    return {
      status: languageStageStatus(progress.stage), current_stage: progress.stage, current_stage_source: 'carrier_map',
      last_status_text: progress.label, last_update: null, expected_delivery: null, ...facts, summary_only: true, events: [],
    };
  }
  // The newest scan with a stage leads; the status stands in when none has one.
  const lead = leadingScan(events, statusMap);
  const stage = (lead?.stage ?? progress?.stage) as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead?.stage ? lead.stage_source ?? 'carrier_map' : 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    ...facts,
    events,
  };
}

/** The tracker's reply as JSON, or the reason it is not one. */
export function comoneJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (isComoneBlocked(body)) throw new ChallengeError(PROVIDER, 'ComOne Express answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'ComOne Express returned a reply that is not JSON', { cause });
  }
}
