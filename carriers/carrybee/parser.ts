import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { epochSecondsTime, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { carryBeeStage } from './status.js';

export const PROVIDER = 'CarryBee';
export const CARRYBEE_ENDPOINT = 'https://api-merchant.carrybee.com/api/v2/track-order';
const ZONE = 'Asia/Dhaka';
const NOT_FOUND_MESSAGE = 'rpc error: code = NotFound desc = record not found';
/** "Sep 13-14, 2025", "Sep 30-Oct 1, 2025" or one day. */
const ESTIMATE = /^([A-Z][a-z]{2}) (\d{1,2})(?:\s*-\s*(?:([A-Z][a-z]{2}) )?(\d{1,2}))?, (\d{4})$/;
/** The rider's name and phone number after the out-for-delivery wording. */
const RIDER = /^(Your parcel is out for delivery)\s+by\b.*$/i;

export function normalizeCarryBeeNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^[A-Z0-9]{6,30}$/.test(number)) throw new InvalidInputError(PROVIDER, 'CarryBee needs a whole consignment ID');
  return number;
}

function text(record: Record<string, unknown>, key: string, max: number): string {
  const value = record[key];
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new SchemaError(PROVIDER, `CarryBee returned an invalid ${key}`);
  return clean(value, max);
}

/** CarryBee's own answer that it holds no such consignment, sent with HTTP 404. */
export function isCarryBeeNotFound(payload: unknown): boolean {
  return isRecord(payload) && payload.error === true && payload.message === NOT_FOUND_MESSAGE;
}

type Scan = { event: CarrierEvent; at: number };

function scan(time: { iso: string; timestamp: number }, description: string, code: string): Scan {
  if (!description || /[<>]/.test(description)) throw new SchemaError(PROVIDER, 'CarryBee returned no scan wording');
  const stage = carryBeeStage(code, description);
  return { at: time.timestamp, event: { time: time.iso, description, provider_code: code,
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}) } };
}

/** The history's rows: a title, its offset clock and the status id it moved the order to. */
function logScans(logs: unknown): Scan[] {
  if (logs == null) return [];
  if (!Array.isArray(logs) || logs.length > 500) throw new SchemaError(PROVIDER, 'CarryBee returned an invalid history');
  return logs.map((row: unknown) => {
    if (!isRecord(row) || !Number.isInteger(row.transfer_status_id)) throw new SchemaError(PROVIDER, 'CarryBee returned an invalid history row');
    const time = explicitOffsetTime(row.date_time_tz);
    if (!time) throw new SchemaError(PROVIDER, 'CarryBee returned an invalid history clock');
    const title = text(row, 'title', 500);
    return scan(time, title.replace(RIDER, '$1'), String(row.transfer_status_id));
  });
}

/**
 * The tracking page's journey: every step it knows, those reached (`status: 1`) with an epoch
 * clock. Steps still ahead (`status: 0`) are not scans.
 */
function stateScans(states: unknown): Scan[] {
  if (!Array.isArray(states) || states.length > 50) throw new SchemaError(PROVIDER, 'CarryBee returned an invalid journey');
  const scans: Scan[] = [];
  for (const row of states as unknown[]) {
    if (!isRecord(row) || (row.status !== 0 && row.status !== 1)) throw new SchemaError(PROVIDER, 'CarryBee returned an invalid journey step');
    const slug = text(row, 'slug', 60);
    if (!/^[a-z_]+$/.test(slug)) throw new SchemaError(PROVIDER, 'CarryBee returned an invalid journey step');
    if (row.status === 0) continue;
    const utc = epochSecondsTime(row.happened_at_utc);
    if (!utc) throw new SchemaError(PROVIDER, 'CarryBee returned an invalid journey clock');
    // The epoch is the instant; Bangladesh keeps one offset all year, the one the page shows.
    const local = DateTime.fromMillis(utc.timestamp, { zone: ZONE });
    scans.push(scan({ iso: local.toISO({ suppressMilliseconds: true })!, timestamp: utc.timestamp }, text(row, 'plain_text', 120), slug));
  }
  return scans;
}

function calendarDay(month: string, day: string, year: number): string | null {
  const parsed = DateTime.fromFormat(`${month} ${day} ${year}`, 'MMM d yyyy', { zone: 'UTC', locale: 'en-US' });
  return parsed.isValid ? parsed.toISODate() : null;
}

/** The delivery estimate, a window of days, for a parcel still on its way; a window over before the newest scan is stale. */
function estimate(order: Record<string, unknown>, stage: Stage | undefined, newest: CarrierEvent)
  : Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> {
  if (stage === 'delivered' || stage === 'returned' || stage === 'exception') return { expected_delivery: null };
  const match = ESTIMATE.exec(text(order, 'estimated_date', 40));
  if (!match) return { expected_delivery: null };
  const [, month, day, endMonth, endDay, yearText] = match;
  const year = Number(yearText);
  const to = calendarDay(endMonth ?? month!, endDay ?? day!, year);
  let from = calendarDay(month!, day!, year);
  if (from && to && from > to) from = calendarDay(month!, day!, year - 1);
  const newestDay = DateTime.fromISO(newest.time!, { setZone: true }).toISODate();
  if (!from || !to || from > to || (newestDay && to < newestDay)) return { expected_delivery: null };
  return { expected_delivery: to, ...(from < to ? { expected_delivery_from: from } : {}) };
}

/**
 * `track-order`'s JSON: the order bound to the whole consignment ID, the page's journey steps
 * with epoch clocks and the history's titles with offset clocks. Names, phone numbers, the
 * address, the merchant and the amounts are never read.
 */
export function parseCarryBee(payload: unknown, raw: string): CarrierResult {
  const number = normalizeCarryBeeNumber(raw);
  if (isCarryBeeNotFound(payload)) throw new NotFoundError(PROVIDER);
  if (!isRecord(payload) || typeof payload.error !== 'boolean') throw new SchemaError(PROVIDER, 'CarryBee returned no tracking envelope');
  if (payload.error) throw new IndeterminateError(PROVIDER, 'CarryBee did not complete the lookup');
  const data = payload.data;
  if (!isRecord(data) || !isRecord(data.order)) throw new SchemaError(PROVIDER, 'CarryBee returned no order');
  const order = data.order;
  if (typeof order.consignment_id !== 'string' || normalizeTrackingNumber(order.consignment_id) !== number) {
    throw new SchemaError(PROVIDER, 'CarryBee returned another consignment');
  }
  const seen = new Set<string>(), scans: Scan[] = [];
  const logs = logScans(data.logs);
  // A step stamped at the same second as a history row repeats it in the page's shorter label.
  const logged = new Set(logs.map(entry => entry.at));
  for (const entry of [...logs, ...stateScans(data.states).filter(entry => !logged.has(entry.at))]) {
    const key = JSON.stringify(entry.event);
    if (!seen.has(key)) { seen.add(key); scans.push(entry); }
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER, 'CarryBee returned no scans');
  const events = scans.sort((a, b) => b.at - a.at).map(entry => entry.event);
  const latest = events[0]!;
  const current = text(order, 'current_status', 120);
  const currentCode = Number.isInteger(order.current_status_id) ? String(order.current_status_id) : null;
  const stage = (current ? carryBeeStage(currentCode, current) : undefined) ?? latest.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? events.find(event => event.stage === 'delivered') : undefined;
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current || latest.description!, last_update: latest.time!,
    ...estimate(order, stage, latest),
    ...(delivered ? { delivered_at: delivered.time! } : {}),
    events: events.slice(0, 100), ...(events.length > 100 ? { history_truncated: true } : {}) };
}
