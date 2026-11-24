import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { codexpressStage, codexpressWording, statusMap } from './status.js';

export const PROVIDER = 'codexpress';
/**
 * The lookup CODExpress's tracking page on Locate2u posts the number to. The host is CODExpress's
 * own: the page relays the lookup to its Locate2u account, so it only answers for that account.
 */
export const CODEXPRESS_LOOKUP = 'https://cbd-tracking.locate2u.com/api/track';
// A delivered parcel's reply is about 230 bytes.
export const CODEXPRESS_MAX_BYTES = 64 * 1024;
/** The tracker's answer for a barcode the account does not hold, with HTTP 404. */
export const CODEXPRESS_NOT_FOUND = 'Tracking ID is invalid. Please use the barcode.';

// Barcodes on CODExpress's labels are CODE and digits; the account looks up any barcode it holds.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// A firewall's, CDN's or bot check's page in place of the tracker's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
// "2026-05-13T15:18:36.000Z": the scan's wall clock, which the reply labels as UTC (see the README).
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,7})?Z?$/;
const MAX_ROWS = 200;

/** A barcode for CODExpress's tracker: letters and digits, in capitals, with at least one digit. */
export function normalizeCodexpressNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'CODExpress looks parcels up by a barcode of 6 to 40 letters and digits');
  return number;
}

/** Whether a reply is a block page instead of the tracker's JSON. */
export function isCodexpressBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** The scan's wall clock, to the second, without the UTC label. */
function wallClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value) : null;
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!match || !day || Number(match[1]) < 2000) return invalid('CODExpress returned a status without its time');
  return `${day}T${match[4]}:${match[5]}:${match[6]}`;
}

/** One status change: Locate2u's status for the parcel and when it changed. */
function eventOf(row: unknown): CarrierEvent & { local_time: string; description: string; provider_code: string } {
  if (!isRecord(row) || typeof row.status !== 'string' || row.status.length > 100) return invalid('CODExpress returned an invalid status');
  const code = clean(row.status, 100) || invalid('CODExpress returned a status without its name');
  const staged = codexpressStage(code);
  return {
    local_time: wallClock(row.dateTime),
    description: codexpressWording(code),
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The tracker's reply for a barcode the account holds: `success`, then the parcel's status history,
 * oldest first, each change with Locate2u's status and its time, and a live-tracking link while a
 * driver has the parcel. The link opens the driver's position on a map and is never read. The
 * reply does not repeat the barcode; the request for it does.
 */
export function parseCodexpress(payload: unknown, rawNumber: string): CarrierResult {
  normalizeCodexpressNumber(rawNumber);
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.data)) return invalid('CODExpress returned an unexpected reply');
  const { history } = payload.data;
  if (!Array.isArray(history)) return invalid('CODExpress returned an invalid history');
  if (history.length > MAX_ROWS) return invalid('CODExpress returned too many statuses');
  // Rows come oldest first; reversed, two of one second keep the tracker's order.
  const events = history.map(eventOf).reverse();
  if (!events.length) throw new NoHistoryError(PROVIDER, 'CODExpress lists the parcel without a status', { reason: 'listed' });
  const latest = events[0]!;
  const current = leadingScan(events, statusMap);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    provider_code: latest.provider_code,
    last_status_text: latest.description,
    last_update: null,
    last_update_local: latest.local_time,
    events,
  };
}

/** Whether a reply is the tracker's answer for a barcode the account does not hold. */
export function isCodexpressNotFound(payload: unknown): boolean {
  return isRecord(payload) && payload.success === false && payload.error === CODEXPRESS_NOT_FOUND && payload.data === undefined;
}

/** The tracker's reply as JSON, or the reason it is not one. */
export function codexpressJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (isCodexpressBlocked(body)) throw new ChallengeError(PROVIDER, 'CODExpress answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'CODExpress returned a reply that is not JSON', { cause });
  }
}
