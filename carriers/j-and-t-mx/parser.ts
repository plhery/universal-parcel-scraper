import { DateTime, FixedOffsetZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  IndeterminateError, InputRequiredError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, textFromHtml } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { jAndTMxStage } from './status.js';

export const PROVIDER = 'J&T Express Mexico';
// A long history is a few dozen kilobytes.
export const J_AND_T_MX_MAX_BYTES = 512 * 1024;
// The waybill the tracking page takes: JMX and twelve digits.
const NUMBER = /^JMX\d{12}$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
/**
 * The zone the lookup is asked for, as the page names its visitor's. Mexico
 * City's UTC-6, which has had no daylight saving since 2022.
 */
export const J_AND_T_MX_REQUEST_ZONE = 'GMT-0600';
const REQUEST_OFFSET = FixedOffsetZone.instance(-6 * 60);
// The reply's codes the page reads: an unknown waybill, and phone digits that are not the parcel's.
const UNKNOWN_WAYBILL = 135020020;
const DIGITS_REFUSED = 1350200268;
// Missing or invalid request parameters: the lookup no longer takes the request as sent.
const REFUSED_REQUEST = new Set([999001010, 999001030]);
const THROTTLED = /too many|too frequent|frequently|rate limit|demasiad|请求(?:过于)?频繁|访问(?:过于)?频繁/i;
// Fields that could name the waybill the answer or a scan belongs to.
const IDENTITY = ['waybillNo', 'billCode', 'keyword'] as const;
// The place the page sets apart at the head of a scan's sentence, in 【】 or square brackets.
const LEADING_PLACE = /^\s*(?:【([^【】]{1,100})】|\[([^[\]]{1,100})\])/u;
// Seven digits in a row are a phone, not a place.
const PHONE = /\d(?:[\s().-]?\d){6}/u;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A waybill for J&T Express Mexico's tracker, in upper case; anything else is not one it issues. */
export function normalizeJAndTMxNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'J&T Express Mexico waybills are JMX and twelve digits');
  return number;
}

/** Any waybill a record names must be the one asked; a record naming none is bound by the one-waybill request. */
function checkIdentity(record: Record<string, unknown>, number: string): void {
  for (const key of IDENTITY) {
    const value = record[key];
    if (value === null || value === undefined || value === '') continue;
    if (typeof value !== 'string') throw new SchemaError(PROVIDER, `J&T Express Mexico returned an invalid ${key}`);
    if (normalizeTrackingNumber(value).toUpperCase() !== number) {
      throw new IndeterminateError(PROVIDER, 'J&T Express Mexico answered for another waybill');
    }
  }
}

/** A scan's instant: `scanTime`, which the tracker writes in the zone the request names. */
function scanInstant(row: Record<string, unknown>): { iso: string; timestamp: number } {
  const match = WALL_CLOCK.exec(typeof row.scanTime === 'string' ? row.scanTime.trim() : '');
  const local = match ? `${match[1]}T${match[2]}` : '';
  const parsed = firstOccurrence(DateTime.fromISO(local, { zone: REQUEST_OFFSET }));
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  const iso = match && parsed.isValid && parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") === local
    ? parsed.toISO({ suppressMilliseconds: true }) : null;
  if (!iso) throw new SchemaError(PROVIDER, 'J&T Express Mexico returned an invalid scan time');
  return { iso, timestamp: parsed.toMillis() };
}

/** The place at the head of a scan's sentence, which the page sets apart; nothing else of the sentence is read. */
function leadingPlace(sentence: unknown): string {
  const match = typeof sentence === 'string' ? LEADING_PLACE.exec(sentence) : null;
  const place = clean(match?.[1] ?? match?.[2], 100);
  return place && !PHONE.test(place) ? place : '';
}

/**
 * One scan: its instant, the label the page lists it under and the place at
 * the head of its sentence. The rest of the sentence (`customerTracking`),
 * which can name the courier, is not read.
 */
function projectRow(row: Record<string, unknown>, number: string): { key: string; timestamp: number; event: CarrierEvent } {
  checkIdentity(row, number);
  if (row.status !== null && row.status !== undefined && typeof row.status !== 'string') {
    throw new SchemaError(PROVIDER, 'J&T Express Mexico returned an invalid scan status');
  }
  const description = textFromHtml(row.status, 120);
  if (!description) throw new SchemaError(PROVIDER, 'J&T Express Mexico returned a scan without a status');
  const { iso, timestamp } = scanInstant(row);
  const location = leadingPlace(row.customerTracking);
  const staged = jAndTMxStage(description);
  const event: CarrierEvent = {
    time: iso,
    description,
    ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([timestamp, description, location]), timestamp, event };
}

/** The refusal or failure a reply that is not a success stands for. */
function failure(payload: Record<string, unknown>): Error {
  const code = payload.code;
  const message = clean(payload.msg, 200);
  if (code === UNKNOWN_WAYBILL) return new NotFoundError(PROVIDER);
  if (code === DIGITS_REFUSED) {
    return new InputRequiredError(PROVIDER, 'phoneDigits', 'J&T Express Mexico has the parcel, but not for these phone digits',
      { reason: 'phone_digits_mismatch' });
  }
  if (THROTTLED.test(message)) return new RateLimitedError(PROVIDER, undefined, 'J&T Express Mexico refused more lookups for now');
  if (typeof code === 'number' && REFUSED_REQUEST.has(code)) {
    return new SchemaError(PROVIDER, 'J&T Express Mexico refused the lookup’s parameters');
  }
  return new IndeterminateError(PROVIDER, 'J&T Express Mexico did not complete the lookup');
}

/**
 * The reply of `getDetailByWaybillNo` for one waybill and its phone digits:
 * `succ` with the answer in `data`, which lists the scans in `details`, newest
 * first. An unknown waybill is code 135020020 whatever the digits, and digits
 * that are not the parcel's are code 1350200268.
 */
export function parseJAndTMx(payload: unknown, raw: string): CarrierResult {
  const number = normalizeJAndTMxNumber(raw);
  if (!isRecord(payload) || typeof payload.succ !== 'boolean') throw new SchemaError(PROVIDER, 'J&T Express Mexico returned an invalid envelope');
  if (!payload.succ) throw failure(payload);
  const answer = payload.data;
  if (!isRecord(answer)) throw new SchemaError(PROVIDER, 'J&T Express Mexico returned no answer for the waybill');
  checkIdentity(answer, number);
  const rows = answer.details ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'J&T Express Mexico returned invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'J&T Express Mexico returned an oversized history');

  const seen = new Set<string>();
  const scans: { timestamp: number; index: number; event: CarrierEvent }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'J&T Express Mexico returned an invalid scan');
    const scan = projectRow(row, number);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push({ timestamp: scan.timestamp, index: scans.length, event: scan.event });
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; scans at one instant keep the reply's order.
  const newestFirst = scans.sort((a, b) => b.timestamp - a.timestamp || a.index - b.index).map(({ event }) => event);
  const newest = newestFirst[0]!;
  const staged = newestFirst.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? staged!.time as string : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
