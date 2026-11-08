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
import { jAndTWording } from '../j-and-t-au/official.js';
import { jAndTCnStage } from './status.js';

export const PROVIDER = 'J&T Express China';
// A long history is a few dozen kilobytes.
export const J_AND_T_CN_MAX_BYTES = 512 * 1024;
// The waybills the tracker takes: JT or UT and thirteen digits; it puts JT before thirteen bare digits.
const NUMBER = /^(?:JT|UT)\d{13}$/;
const BARE = /^\d{13}$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// Scan times are Beijing time, which has no daylight saving.
const BEIJING = FixedOffsetZone.instance(8 * 60);
const ANSWERED = 1;
// The reply to phone digits that are not the parcel's, which is also the reply for a waybill J&T does not know.
const DIGITS_REFUSED = 1350200255;
// A request the lookup does not take: a signature, or a second-stage code, it refuses.
const REFUSED_REQUEST = new Set([149000017]);
const THROTTLED = /too many|too frequent|rate limit|请求(?:过于)?频繁|访问(?:过于)?频繁|操作(?:过于)?频繁/i;
const MAX_ANSWERS = 10;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A waybill for J&T Express China's tracker, in upper case and with JT before thirteen bare digits. */
export function normalizeJAndTCnNumber(raw: string): string {
  const typed = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  const number = BARE.test(typed) ? `JT${typed}` : typed;
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'J&T Express China waybills are JT or UT and thirteen digits');
  return number;
}

/** The refusal or failure a reply that is not an answer stands for. */
function failure(payload: Record<string, unknown>): Error {
  const message = clean(payload.msg, 200);
  if (payload.code === DIGITS_REFUSED) {
    return new InputRequiredError(PROVIDER, 'phoneDigits', 'J&T Express China refused these phone digits for the waybill',
      { reason: 'phone_digits_mismatch' });
  }
  if (THROTTLED.test(message)) return new RateLimitedError(PROVIDER, undefined, 'J&T Express China refused more lookups for now');
  if (typeof payload.code === 'number' && REFUSED_REQUEST.has(payload.code)) {
    return new SchemaError(PROVIDER, 'J&T Express China refused the lookup’s signature or parameters');
  }
  return new IndeterminateError(PROVIDER, 'J&T Express China did not complete the lookup');
}

/**
 * The answer for the waybill in a reply of `trackingCustomerByWaybillNo`:
 * code 1 with one answer in `data` per waybill it knows, naming the waybill
 * in `keyword`. A waybill left out is one the page reports as not found.
 */
export function jAndTCnAnswer(payload: unknown, number: string): Record<string, unknown> {
  if (!isRecord(payload) || typeof payload.code !== 'number') throw new SchemaError(PROVIDER, 'J&T Express China returned an invalid envelope');
  if (payload.code !== ANSWERED) throw failure(payload);
  const answers = payload.data ?? [];
  if (!Array.isArray(answers) || answers.length > MAX_ANSWERS) throw new SchemaError(PROVIDER, 'J&T Express China returned invalid answers');
  for (const answer of answers) {
    if (!isRecord(answer) || typeof answer.keyword !== 'string' || !answer.keyword) {
      throw new SchemaError(PROVIDER, 'J&T Express China did not name the waybill it answered for');
    }
    if (normalizeTrackingNumber(answer.keyword).toUpperCase() !== number) {
      throw new IndeterminateError(PROVIDER, 'J&T Express China answered for another waybill');
    }
  }
  if (answers.length > 1) throw new SchemaError(PROVIDER, 'J&T Express China returned more than one answer for the waybill');
  const answer = answers[0] as Record<string, unknown> | undefined;
  if (!answer) throw new NotFoundError(PROVIDER);
  if (answer.details !== undefined && answer.details !== null && !Array.isArray(answer.details)) {
    throw new SchemaError(PROVIDER, 'J&T Express China returned invalid scans');
  }
  return answer;
}

/** Whether an answer lists scans; the page asks the second stage for those of an answer that lists none. */
export function jAndTCnHasScans(answer: Record<string, unknown>): boolean {
  return Array.isArray(answer.details) && answer.details.length > 0;
}

/** A scan's instant: `scanTime` on Beijing's clock. */
function scanInstant(row: Record<string, unknown>): { iso: string; timestamp: number } {
  const match = WALL_CLOCK.exec(typeof row.scanTime === 'string' ? row.scanTime.trim() : '');
  const local = match ? `${match[1]}T${match[2]}` : '';
  const parsed = firstOccurrence(DateTime.fromISO(local, { zone: BEIJING }));
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  const iso = match && parsed.isValid && parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") === local
    ? parsed.toISO({ suppressMilliseconds: true }) : null;
  if (!iso) throw new SchemaError(PROVIDER, 'J&T Express China returned an invalid scan time');
  return { iso, timestamp: parsed.toMillis() };
}

/**
 * One scan: its instant and the status the page heads it with, such as
 * 运送中. A scan without one has its sentence without the people, phones and
 * bracketed text it can name; a sentence left with nothing is no scan.
 */
function projectRow(row: Record<string, unknown>): { key: string; timestamp: number; event: CarrierEvent } | null {
  if (row.status !== null && row.status !== undefined && typeof row.status !== 'string') {
    throw new SchemaError(PROVIDER, 'J&T Express China returned an invalid scan status');
  }
  const { iso, timestamp } = scanInstant(row);
  const label = textFromHtml(row.status, 120);
  // Text cut out of a Chinese sentence leaves no space between the characters around it.
  const description = label || jAndTWording(clean(row.customerTracking, 1000)).replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, '').slice(0, 300);
  if (!description) return null;
  const staged = jAndTCnStage(description);
  const event: CarrierEvent = {
    time: iso,
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([timestamp, description]), timestamp, event };
}

/** The scans of the waybill's answer, newest first, as the page lists them. */
export function parseJAndTCn(answer: Record<string, unknown>, raw: string): CarrierResult {
  const number = normalizeJAndTCnNumber(raw);
  if (typeof answer.keyword !== 'string' || normalizeTrackingNumber(answer.keyword).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'J&T Express China answered for another waybill');
  }
  const rows = answer.details ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'J&T Express China returned invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'J&T Express China returned an oversized history');
  const seen = new Set<string>();
  const scans: { timestamp: number; index: number; event: CarrierEvent }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'J&T Express China returned an invalid scan');
    const scan = projectRow(row);
    if (!scan || seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push({ timestamp: scan.timestamp, index: scans.length, event: scan.event });
  }
  // The phone digits matched, so J&T knows the waybill: without scans it has no history yet.
  if (!scans.length) throw new NoHistoryError(PROVIDER);
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
