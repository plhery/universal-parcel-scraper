import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { runforintStage, statusMap } from './status.js';

export const PROVIDER = 'Runforint';
export const CARRIER = 'runforint';
// One parcel's reply is a few kilobytes.
export const RUNFORINT_MAX_BYTES = 512 * 1024;
// RF and digits; the public waybill has twelve.
const NUMBER = /^RF\d{10,14}$/;
// The answer for a number the tracker holds nothing under: "the system has no record of the number".
const UNKNOWN = /系统无单号记录|无单号记录/;
// The answer to a lookup sent within a second or so of another: "request limit exceeded".
const LIMITED = /超出请求次数限制|请求(?:次数|过于频繁)/;
// The answer to a request whose signature or clock the service rejects.
const REFUSED = /签名|signature|时间戳|timestamp/i;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
const OFFSET = /^[+-](?:0\d|1[0-4]):[0-5]\d$/;
const DESTINATION = /\(([A-Z]{2})\)\s*$/;
const MAX_ROWS = 500;

/** A Runforint waybill, without spaces or hyphens. Anything else is not a number it issues. */
export function normalizeRunforintNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Runforint waybills are RF and digits');
  return number;
}

/** The reply's JSON. A bot check in its place is a challenge, anything else a changed reply. */
export function runforintJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`, { cause });
    throw new SchemaError(PROVIDER, `${PROVIDER} returned a reply that is not JSON`, { cause });
  }
}

function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's wall clock to the second, and its instant when the scan states a valid offset. */
function clock(row: Record<string, unknown>): { local: string; instant?: string } {
  const match = CLOCK.exec(text(row, 'DateTime', 40));
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00:00 over, so only a clock that reads back unchanged is kept.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan time`);
  }
  const offset = text(row, 'DateTimeZone', 16);
  const instant = OFFSET.test(offset) ? explicitOffsetTime(`${local}${offset}`) : null;
  return instant ? { local, instant: instant.iso } : { local };
}

/**
 * A parcel's scans, newest first. The service lists them oldest first, each a
 * wall clock without its zone on every reply seen, and the tracking page
 * orders them by that clock; equal clocks keep the service's order, newest
 * last. A row without wording says nothing, and a repeated one is read once.
 */
function scans(rows: unknown[]): CarrierEvent[] {
  const seen = new Set<string>();
  const read: { local: string; event: CarrierEvent }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan`);
    const { local, instant } = clock(row);
    const description = text(row, 'Info');
    if (!description) continue;
    // The place the scan names, else its city, state and country; never its postcode.
    const location = text(row, 'Address', 120)
      || ['City', 'State', 'Country'].map((key) => text(row, key, 60)).filter(Boolean).join(', ');
    const status = row.Status;
    if (status !== null && status !== undefined && (typeof status !== 'number' || !Number.isInteger(status) || status < 0 || status > 9999)) {
      throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan status`);
    }
    const code = typeof status === 'number' ? String(status) : '';
    const key = JSON.stringify([instant ?? local, location, description, code]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = runforintStage(description, code);
    read.push({ local, event: {
      ...(instant ? { time: instant } : { local_time: local }),
      ...(location ? { location } : {}),
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!read.length) throw new NoHistoryError(PROVIDER);
  // Newest first: the service's order reversed, then by clock, which keeps equal clocks in that order.
  return read.reverse().sort((left, right) => (left.local < right.local ? 1 : left.local > right.local ? -1 : 0)).map((scan) => scan.event);
}

/**
 * The reply of the tracking page's `waybill_track` lookup. `S1` holds an entry
 * per number found, with its scans; `E1` with "the system has no record of the
 * number" is the answer for a number the tracker does not know, and `E1` with
 * "request limit exceeded" the answer to a lookup sent too soon after another. Only the entry
 * whose `ShipmentNo` is the whole number asked is read; the merchant's name is
 * never kept.
 */
export function parseRunforint(payload: unknown, raw: string): CarrierResult {
  const number = normalizeRunforintNumber(raw);
  if (!isRecord(payload) || typeof payload.Code !== 'string') throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  const message = text(payload, 'Message', 200);
  if (payload.Code !== 'S1') {
    if (UNKNOWN.test(message)) throw new NotFoundError(PROVIDER, `${PROVIDER} has no parcel under this number`);
    if (LIMITED.test(message)) throw new RateLimitedError(PROVIDER);
    if (REFUSED.test(message)) throw new SchemaError(PROVIDER, `${PROVIDER} refused the lookup request`);
    throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  }
  const { TrackSysResponseDataList: list, TrackSysResponseErrorList: errors } = payload;
  if (!Array.isArray(list) || !Array.isArray(errors)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  const bound = list.filter((item: unknown) => isRecord(item) && typeof item.ShipmentNo === 'string'
    && normalizeTrackingNumber(item.ShipmentNo) === number) as Record<string, unknown>[];
  if (bound.length !== 1) {
    // A per-number error, whose wordings are not known yet, is not a missing parcel.
    if (!bound.length && errors.some((item: unknown) => isRecord(item) && typeof item.ShipmentNo === 'string'
      && normalizeTrackingNumber(item.ShipmentNo) === number)) throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
    throw new SchemaError(PROVIDER, `${PROVIDER} did not answer for the parcel asked`);
  }
  const item = bound[0]!;
  const rows = item.TrackSysInfoResponseList;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, `${PROVIDER} returned a parcel with invalid scans`);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);
  const events = scans(rows);
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  const destination = DESTINATION.exec(text(item, 'Destination', 60))?.[1];
  const country = destination ? countryCode(destination) : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    events,
  };
}
