import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { airroadDepot, airroadStage } from './status.js';

export const PROVIDER = 'airroad';
/** The lookup AirRoad's Quick Track page reads, with the consignment number appended to the path. */
export const AIRROAD_LOOKUP = 'https://my.airroad.com.au/api/QuickTrack/';
// A consignment's reply is about 150 bytes.
export const AIRROAD_MAX_BYTES = 64 * 1024;

// Letters and digits, with at least one digit; the public samples are a three-letter code and seven digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// A firewall's, CDN's or bot check's page in place of the lookup's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
// "2026-04-21T12:20:00": a wall clock without a zone, as the page shows it.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,7})?$/;
// The estimate's day; the page shows the part before the "T".
const DAY = /^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]{0,20})?$/;
// The lookup's answer for a number it does not know names that number.
const NOT_FOUND = /^(\S{1,64}) not found\.$/;

/** A consignment number for Quick Track, which matches it whole and in capitals, as its page sends it. */
export function normalizeAirroadNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'AirRoad consignment numbers are 6 to 30 letters and digits');
  return number;
}

/** Whether a reply is a block page instead of the lookup's JSON. */
export function isAirroadBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A clock as the reply gives it, to the second, or null for .NET's empty date. */
function wallClock(value: unknown): string | null {
  const match = typeof value === 'string' ? CLOCK.exec(value) : null;
  if (!match) return invalid('AirRoad returned a status without its time');
  if (Number(match[1]) < 2000) return null;
  const day = calendarDay(Number(match[1]), Number(match[2]), Number(match[3]));
  return day ? `${day}T${match[4]}:${match[5]}:${match[6]}` : invalid('AirRoad returned an invalid status time');
}

/** The estimated delivery day the page shows, while the consignment is on its way and the day is not behind its status. */
function estimateOf(value: unknown, delivered: boolean, status: string): string | null {
  if (value === null || value === undefined) return null;
  const match = typeof value === 'string' ? DAY.exec(value) : null;
  if (!match) return invalid('AirRoad returned an invalid delivery estimate');
  const day = calendarDay(Number(match[1]), Number(match[2]), Number(match[3]));
  if (!day || Number(match[1]) < 2000 || delivered || day < status.slice(0, 10)) return null;
  return day;
}

/**
 * Quick Track's reply for one consignment: a list holding its number, the time and text of its
 * current status, whether it is delivered, an estimated delivery date and an empty scan list.
 * A delivered consignment's status text names who took the goods; it is never read. The list must
 * name the number asked: the lookup also matches other references and then names another
 * consignment.
 */
export function parseAirroad(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeAirroadNumber(rawNumber);
  if (!Array.isArray(payload) || payload.length < 1 || payload.length > 10 || !payload.every(isRecord)) {
    return invalid('AirRoad returned an unexpected reply');
  }
  if (payload.some((row) => typeof row.connoteCode !== 'string')) return invalid('AirRoad returned a consignment without its number');
  const rows = payload.filter((row) => normalizeTrackingNumber(row.connoteCode as string).toUpperCase() === number);
  if (rows.length !== 1) {
    throw new IndeterminateError(PROVIDER, rows.length ? 'AirRoad listed the consignment twice' : 'AirRoad answered for another consignment');
  }
  const row = rows[0]!;
  if (typeof row.delivered !== 'boolean') return invalid('AirRoad returned a consignment without its delivery flag');
  if (row.scans !== null && row.scans !== undefined && !Array.isArray(row.scans)) return invalid('AirRoad returned invalid scans');
  const { delivered } = row;
  if (!delivered && row.statusText !== null && row.statusText !== undefined && typeof row.statusText !== 'string') {
    return invalid('AirRoad returned an invalid status');
  }
  const text = delivered ? 'Delivered' : clean(row.statusText, 200);
  if (!text) throw new NoHistoryError(PROVIDER, 'AirRoad lists the consignment without a status', { reason: 'listed' });
  const local = wallClock(row.statusDate) ?? invalid('AirRoad returned a status without its time');
  const staged = airroadStage(text);
  const depot = delivered ? undefined : airroadDepot(text);
  const event: CarrierEvent = {
    local_time: local,
    description: text,
    ...(depot ? { location: depot } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return {
    status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: text,
    last_update: null,
    last_update_local: local,
    expected_delivery: estimateOf(row.estimatedDeliveryDate, delivered, local),
    summary_only: true,
    events: [event],
  };
}

/** Whether a reply is the lookup's answer for a number it does not know, and which number it names. */
export function airroadNotFoundNumber(payload: unknown): string | undefined {
  if (!isRecord(payload) || typeof payload.message !== 'string' || Object.keys(payload).length !== 1) return undefined;
  return NOT_FOUND.exec(payload.message)?.[1];
}

/** The lookup's reply as JSON, or the reason it is not one. */
export function airroadJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (isAirroadBlocked(body)) throw new ChallengeError(PROVIDER, 'AirRoad answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'AirRoad returned a reply that is not JSON', { cause });
  }
}
