import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { isZtoTrackingNumber } from '../../core/detection/zto.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { hdExpressStage, statusMap } from './status.js';

export const PROVIDER = 'HD Express';
export const CARRIER = 'hd-express';
// A parcel's history is a kilobyte or two.
export const HD_EXPRESS_MAX_BYTES = 256 * 1024;
// Letters and digits, with a digit: HDC and eleven digits on the public sample.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
const HOME = 'America/Vancouver';
const CHINA = 'Asia/Shanghai';
// The row that says the parcel left Canada for China, and the step `state` gives it.
const DEPARTED = /^快件已发往国内/u;
const DEPARTED_STATE = 4;
// "2022-12-28 17:21:16.0": the wall clock the system writes, with its fraction of a second.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?$/;
// ZTO's waybill as the customs row gives it: "(中通单号：…)".
const ZTO = /\s*[（(]\s*中通(?:快递)?(?:运单号|单号)\s*[:：]?\s*(\d{10,16})\s*[)）]/u;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const MAX_ROWS = 200;

/** A waybill on HD Express's tracker, without spaces or hyphens. */
export function normalizeHdExpressNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'HD Express waybills are 8 to 30 letters and digits');
  return number;
}

/** A reply that is not the tracker's JSON: a browser check, or a changed route. */
export function notJson(body: string): never {
  if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  throw new SchemaError(PROVIDER, `${PROVIDER} returned a reply that is not its tracking JSON`);
}

interface Row {
  readonly id: number;
  readonly local: string;
  readonly state: number | null;
  readonly description: string;
  readonly original: string;
  readonly location: string;
  readonly zto: string;
}

function text(value: unknown, maxLength: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > maxLength * 4) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan`);
  return clean(value, maxLength);
}

/** A row's wall clock, to the second, checked against the calendar. */
function wallClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const local = match ? `${match[1]}T${match[2]}` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan time`);
  }
  return local;
}

/** One row of the reply for the number asked, or null for another waybill's. */
function row(value: unknown, number: string): Row | null {
  if (!isRecord(value) || typeof value.waybillNo !== 'string') throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan`);
  if (normalizeTrackingNumber(value.waybillNo) !== number) return null;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 0) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan`);
  const state = value.state === null || value.state === undefined ? null : value.state;
  if (state !== null && !Number.isSafeInteger(state)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan`);
  const original = text(value.description, 300);
  const named = ZTO.exec(original);
  const zto = named && isZtoTrackingNumber(named[1]!) && named[1] !== number ? named[1]! : '';
  return {
    id: value.id as number, local: wallClock(value.updateTime), state: state as number | null,
    description: zto ? clean(original.replace(ZTO, ''), 300) : original, original, location: text(value.location, 120), zto,
  };
}

/**
 * The reply's rows for the whole number asked, oldest first by the order the
 * system wrote them. A reply whose rows are all another waybill's is not an
 * answer for this one.
 */
export function hdExpressRows(payload: unknown, raw: string): Row[] {
  const number = normalizeHdExpressNumber(raw);
  if (!isRecord(payload) || !Number.isSafeInteger(payload.code)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  if (payload.code !== 0) throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  if (!Array.isArray(payload.data)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  // The tracker's answer for a number it holds nothing under: success and no row.
  if (payload.data.length === 0) {
    if (payload.msg !== '成功') throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
    throw new NotFoundError(PROVIDER, `${PROVIDER} has no parcel under this number`);
  }
  if (payload.data.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);
  const rows = payload.data.map((value) => row(value, number)).filter((value): value is Row => value !== null);
  if (!rows.length) throw new SchemaError(PROVIDER, `${PROVIDER} did not answer for the parcel asked`);
  return rows.sort((left, right) => left.id - right.id);
}

/**
 * HD Express's history for one waybill, newest first. The system writes each
 * row's clock without its zone. The rows up to the parcel's departure for
 * China are Vancouver's, the head office's; from the departure row on, step 4
 * of `state`, they are on China's clock, where the parcel clears customs and
 * a Chinese courier delivers it. A zone that would date a row after the
 * lookup leaves it its wall clock alone. ZTO becomes the delivery carrier
 * with the waybill a row names as ZTO's.
 */
export function parseHdExpress(payload: unknown, raw: string, readAt = Date.now()): CarrierResult {
  const rows = hdExpressRows(payload, raw);
  const departure = rows.findIndex((entry) => DEPARTED.test(entry.description) || (entry.state ?? 0) >= DEPARTED_STATE);
  const seen = new Set<string>();
  const dated = rows.flatMap((entry, index) => {
    if (!entry.description) return [];
    const key = JSON.stringify([entry.local, entry.description, entry.state]);
    if (seen.has(key)) return [];
    seen.add(key);
    const china = departure >= 0 && index >= departure;
    const zone = china ? CHINA : HOME;
    const instant = firstOccurrence(DateTime.fromISO(entry.local, { zone }));
    const code = entry.state === null ? '' : String(entry.state);
    const staged = hdExpressStage(entry.description, code);
    const event: CarrierEvent = {
      ...(instant.toMillis() <= readAt + CLOCK_SKEW_MS
        ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: zone, time_zone_basis: china ? 'destination' : 'carrier' } : {}),
      local_time: entry.local,
      ...(entry.location ? { location: entry.location } : {}),
      description: entry.description,
      ...(entry.description !== entry.original ? { original_description: entry.original } : {}),
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return [{ order: instant.toMillis(), id: entry.id, event }];
  });
  if (!dated.length) throw new NoHistoryError(PROVIDER);
  const events = dated.sort((left, right) => right.order - left.order || right.id - left.id).map((entry) => entry.event);
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  const zto = [...rows].reverse().find((entry) => entry.zto)?.zto;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(departure >= 0 ? { destination_country: 'CN' } : {}),
    ...(zto ? { delivery_carrier: 'zto', delivery_tracking_number: zto } : {}),
    events,
  };
}
