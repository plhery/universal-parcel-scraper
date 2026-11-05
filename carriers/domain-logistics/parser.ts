import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { windowEstimate } from '../../core/result/window.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { domainLogisticsStage } from './status.js';

export const PROVIDER = 'Domain Logistics';
// An order's reply is under a kilobyte.
export const DOMAIN_LOGISTICS_MAX_BYTES = 64 * 1024;
// The page sends whatever is typed. Lookups carry twelve digits and its form's example nine
// letters and digits, so the adapter takes letters and digits with a digit and leaves the
// layout to the service.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// A row's `Date`: the day, a line break and a twelve-hour clock, as "2026-01-02<br/>09:30 PM".
const CLOCK = /^(\d{4}-\d{2}-\d{2})\s*<br\s*\/?>\s*(\d{1,2}):(\d{2})\s*([AP]M)$/i;
// A row's `Estimated`: the day, then nothing, an arrival time or a window, as
// "2026-01-02<br/>05:00 PM – 10:30 PM".
const ESTIMATE = /^(\d{4}-\d{2}-\d{2})(?:\s*<br\s*\/?>(.*)|$)/is;
const ARRIVAL = /^(\d{1,2}):(\d{2})\s*([AP]M)(?:\s*[–-]\s*(\d{1,2}):(\d{2})\s*([AP]M))?$/i;
const FINAL: readonly Stage[] = ['delivered', 'returned'];
const MAX_ROWS = 100;

/** A number for Domain's tracking service, in capitals; anything else is not one it issues. */
export function normalizeDomainLogisticsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Domain Logistics numbers are six to forty letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function field(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Domain Logistics returned an invalid ${key}`);
  return value.trim().slice(0, 300);
}

/** A calendar day the reply writes, checked by reading it back. */
function day(value: string): string | null {
  // UTC only checks the calendar digits; the day keeps no zone.
  const parsed = DateTime.fromISO(value, { zone: 'UTC' });
  return parsed.isValid && parsed.toISODate() === value ? value : null;
}

/** A twelve-hour clock as `HH:MM`, or null when it is not one. */
function twelveHour(hour: string, minute: string, meridiem: string): string | null {
  const [hours, minutes] = [Number(hour), Number(minute)];
  if (hours < 1 || hours > 12 || minutes > 59) return null;
  return `${String((hours % 12) + (meridiem.toUpperCase() === 'PM' ? 12 : 0)).padStart(2, '0')}:${minute}`;
}

/**
 * A row's clock. The page prints it as it comes; it reads as Ontario's wall clock, but the
 * reply names no zone, so the clock stays local.
 */
function wallClock(raw: string): string {
  const match = CLOCK.exec(raw);
  const clock = match ? twelveHour(match[2]!, match[3]!, match[4]!) : null;
  if (!match || !clock || !day(match[1]!)) throw new SchemaError(PROVIDER, 'Domain Logistics returned an invalid status time');
  const local = `${match[1]}T${clock}:00`;
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) throw new SchemaError(PROVIDER, 'Domain Logistics returned an invalid status time');
  return local;
}

interface Estimate {
  day: string;
  /** The day, its arrival time or its window, as `expected_delivery` carries it. */
  value: string;
  /** The wall clock the arrival time or window ends at, `YYYY-MM-DDTHH:MM`. */
  ends: string | null;
}

interface Row { event: CarrierEvent; local: string; service: string; estimate: Estimate | null }

/**
 * A row's `Estimated`: its day, with the arrival time or window after it on the same wall
 * clock as the rows. Anything else after the day leaves the day alone.
 */
function estimateOf(raw: string): Estimate | null {
  const match = ESTIMATE.exec(raw);
  const date = match ? day(match[1]!) : null;
  if (!date) return null;
  const time = ARRIVAL.exec(textFromHtml(match![2] ?? '', 80));
  const from = time ? twelveHour(time[1]!, time[2]!, time[3]!) : null;
  const to = time?.[4] ? twelveHour(time[4], time[5]!, time[6]!) : from;
  if (!from || !to) return { day: date, value: date, ends: null };
  const value = windowEstimate(`${date} ${from}`, `${date} ${to}`).expected_delivery ?? date;
  return { day: date, value, ends: value === date ? null : `${date}T${to}` };
}

function projectRow(row: unknown): Row {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Domain Logistics returned an invalid status row');
  // The page writes each value in as HTML.
  const description = textFromHtml(field(row, 'Status'), 200);
  if (!description) throw new SchemaError(PROVIDER, 'Domain Logistics returned a row without its status');
  const local = wallClock(field(row, 'Date'));
  // `Note` is the page's advice beside a status, about the estimate or the delivery; it is not read.
  field(row, 'Note');
  const estimate = estimateOf(field(row, 'Estimated'));
  const staged = domainLogisticsStage(description);
  return {
    local,
    service: textFromHtml(field(row, 'Service'), 80),
    estimate,
    event: { local_time: local, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) },
  };
}

/**
 * The newest status's estimate, until the order is delivered: none once its day has passed, and
 * its day alone once its arrival time or window ended before the newest status.
 */
function currentEstimate(estimate: Estimate | null, newest: string): string | null {
  if (!estimate || estimate.day < newest.slice(0, 10)) return null;
  return estimate.ends && estimate.ends < newest.slice(0, 16) ? estimate.day : estimate.value;
}

/**
 * The reply of `GET api.domainlogistics.ca/domaintracking/api/tracking/{number}`: the order's
 * statuses, newest first, each with the delivery service, its own estimate and its clock. The
 * reply never repeats the number; the request path binds it to the whole number asked. An
 * empty reply is an order without a status yet, which the page asks to check again later.
 */
export function parseDomainLogistics(payload: unknown): CarrierResult {
  if (payload === null || (Array.isArray(payload) && payload.length === 0)) throw new NoHistoryError(PROVIDER);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'Domain Logistics returned an invalid reply');
  if (payload.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Domain Logistics returned an oversized history');

  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const raw of payload) {
    const row = projectRow(raw);
    const key = JSON.stringify([row.local, row.event.description]);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  // Newest first, as the page lists them; a row keeps its place before an older one at the same minute.
  if (listsNewestFirst(rows.map(({ event }) => event)) === false) rows.reverse();
  rows.sort((a, b) => b.local.localeCompare(a.local));

  const newest = rows[0]!;
  const scanned = rows.find((row) => row.event.stage)?.event;
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.event.description!,
    last_update: null,
    last_update_local: newest.local,
    expected_delivery: stage && FINAL.includes(stage) ? null : currentEstimate(newest.estimate, newest.local),
    ...(newest.service ? { service_name: newest.service } : {}),
    events: rows.map((row) => row.event),
  };
}
