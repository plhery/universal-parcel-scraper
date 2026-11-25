import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { flipEventStage, statusMap } from './status.js';

export const PROVIDER = 'flipxpress';
/** The lookup Flip Xpress's tracking page asks, with the number as `awb_number`. */
export const FLIP_LOOKUP = 'https://portal.flipxp.com/apis/manifest_status_multiple';
// A delivered shipment's reply is about 2 KB.
export const FLIP_MAX_BYTES = 256 * 1024;

// Waybills are letters, digits and hyphens. The lookup takes several numbers joined by commas, so
// a separator is never sent.
const NUMBER = /^(?=[A-Z-]*\d)[A-Z0-9](?:[A-Z0-9-]{4,38})[A-Z0-9]$/;
// A firewall's, CDN's or bot check's page in place of the tracker's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
const MAX_EVENTS = 300;

// A booking reference: TL, the year and month, a hyphen and a serial, as TL202601-023818.
const BOOKING = /^TL(\d{6})(\d{6})$/;

/** A waybill in capitals, without spaces. */
function waybill(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/** A waybill's letters and digits: how two forms of one waybill compare. */
const bare = (number: string) => number.replace(/-/g, '');

/** A number for Flip Xpress's tracker. */
export function normalizeFlipNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? waybill(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Flip Xpress tracks waybills of 6 to 40 letters, digits and hyphens');
  return number;
}

/**
 * The forms of a number the lookup is asked for, joined by commas as the tracking page joins
 * several. The tracker finds a booking reference only with its hyphen, which the normalized
 * number a consumer stores has lost, so that form is asked as well.
 */
export function flipLookupForms(number: string): string[] {
  const booking = BOOKING.exec(bare(number));
  const forms = booking ? [number, `TL${booking[1]}-${booking[2]}`] : [number];
  return [...new Set(forms)];
}

/** Whether a reply is a block page instead of the tracker's JSON. */
export function isFlipBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

function text(value: unknown, max: number, what: string): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? clean(value, max) : invalid(`Flip Xpress returned an invalid ${what}`);
}

/**
 * One status: its code, its wording and the instant. `status_real_name` is the wording the
 * tracking page shows; `status_name` adds the driver's code and the name of whoever took the
 * parcel, so it is never read, nor is the driver's code.
 */
function eventOf(row: unknown): CarrierEvent {
  if (!isRecord(row)) return invalid('Flip Xpress returned an invalid status');
  const wording = text(row.status_real_name, 120, 'status') || invalid('Flip Xpress returned a status without its wording');
  const exception = text(row.exception, 120, 'exception');
  const description = exception ? `${wording} - ${exception}` : wording;
  const code = row.status_code === null || row.status_code === undefined ? null
    : typeof row.status_code === 'number' && Number.isSafeInteger(row.status_code) && row.status_code >= 0 ? String(row.status_code)
      : typeof row.status_code === 'string' && /^\d{1,6}$/.test(row.status_code.trim()) ? row.status_code.trim()
        : invalid('Flip Xpress returned an invalid status code');
  // The tracker states each instant in UTC, and the tracking page shows it on the reader's clock.
  const instant = explicitOffsetTime(row.timestamp) ?? invalid('Flip Xpress returned a status without its time');
  const staged = flipEventStage(code, wording);
  return {
    time: instant.iso,
    description,
    ...(code === null ? {} : { provider_code: code }),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The reply of `GET portal.flipxp.com/apis/manifest_status_multiple`, the lookup Flip Xpress's
 * tracking page makes: one entry per waybill it holds among those asked, each with its statuses,
 * oldest first. An unknown waybill gets an empty list.
 *
 * The sender's and recipient's addresses, the parcel's contents and the drivers' codes are never read.
 */
export function parseFlip(payload: unknown, raw: string): CarrierResult {
  const number = normalizeFlipNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.data)) return invalid('Flip Xpress returned an unexpected reply');
  if (payload.status !== 1) throw new IndeterminateError(PROVIDER, 'Flip Xpress did not complete the lookup');
  // The tracker's own answer for a waybill it does not hold: the lookup succeeds with no entry.
  if (payload.data.length === 0) throw new NotFoundError(PROVIDER, 'Flip Xpress has no shipment under this number');
  const entries = payload.data.filter(isRecord);
  if (entries.length !== payload.data.length) return invalid('Flip Xpress returned an invalid shipment');
  // The reply must name the number asked, with or without the hyphen the normalized number lost.
  const entry = entries.find((item) => typeof item.awb_number === 'string' && bare(waybill(item.awb_number)) === bare(number));
  if (!entry) throw new IndeterminateError(PROVIDER, 'Flip Xpress answered for another shipment');
  if (!Array.isArray(entry.tracking)) return invalid('Flip Xpress returned a shipment without its statuses');
  if (entry.tracking.length > MAX_EVENTS) return invalid('Flip Xpress returned too many statuses');
  const events = entry.tracking.map(eventOf).reverse();
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER, 'Flip Xpress lists the shipment without a status', { reason: 'listed' });
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    expected_delivery: null,
    events,
  };
}

/** The tracker's reply as JSON, or the reason it is not one. */
export function flipJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (isFlipBlocked(body)) throw new ChallengeError(PROVIDER, 'Flip Xpress answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Flip Xpress returned a reply that is not JSON', { cause });
  }
}
