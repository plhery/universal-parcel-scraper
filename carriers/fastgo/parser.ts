import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { fastgoStage, statusMap } from './status.js';

export const PROVIDER = 'Fastgo';
export const CARRIER = 'fastgo';
export const FASTGO_MAX_BYTES = 256_000;
// The tracking page takes letters and digits; the public waybill is AU, nine digits and SG.
const NUMBER = /^[A-Z0-9]{6,30}$/;
// "2019-12-09 14:23:05": a wall clock to the second, without a zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const MAX_SCANS = 200;
// The last leg's courier as the tracking page names it, with the catalog's id: the page shows the logos of these two.
const COURIERS: readonly (readonly [RegExp, string])[] = [[/^EMS$/i, 'china-post'], [/^顺丰速运$/u, 'sf-express']];

/** A Fastgo waybill, as its tracking page sends it: letters and digits, without spaces or hyphens. */
export function normalizeFastgoNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Fastgo waybills are letters and digits');
  return number;
}

function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > maxLength * 4) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's wall clock, checked against the calendar. */
function wallClock(value: string): string {
  const match = CLOCK.exec(value);
  if (!match) throw new SchemaError(PROVIDER, `${PROVIDER} returned a scan without its clock`);
  const [, year, month, day, hour, minute, second] = match.map(Number) as [number, number, number, number, number, number, number];
  if (!calendarDay(year, month, day) || hour > 23 || minute > 59 || second > 59) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an impossible scan clock`);
  }
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
}

/** The courier of the last leg and its number, when the waybill names one whose own rules take the number. */
function lastLeg(waybill: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number' | 'destination_country'> {
  const onward = normalizeTrackingNumber(text(waybill, 'expressno', 64));
  if (!NUMBER.test(onward) || onward === number) return {};
  const alias = text(waybill, 'expressalias', 40);
  const named = COURIERS.find(([name]) => name.test(alias))?.[1];
  if (!named || !(detectCarrierMatch(onward).candidates as string[]).includes(named)) return { delivery_tracking_number: onward };
  // Both couriers deliver within China.
  return { delivery_carrier: named, delivery_tracking_number: onward, destination_country: 'CN' };
}

/**
 * The waybill a reply holds for the number asked. `GET /api/route/{number}` answers one waybill as
 * `result`; `POST /api/route/getRoutes` answers a list, and the tracking page reads a number it
 * leaves out of the list as not existing. Any code but `0000` is a failure, never a missing waybill.
 */
function waybillOf(payload: unknown, number: string): Record<string, unknown> {
  if (!isRecord(payload) || typeof payload.code !== 'string') throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  if (payload.code !== '0000') throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  const listed: unknown[] | null = Array.isArray(payload.result) ? payload.result as unknown[]
    : isRecord(payload.result) ? [payload.result] : null;
  if (!listed || listed.length > 40) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid list of waybills`);
  if (!listed.length) throw new NotFoundError(PROVIDER, `${PROVIDER} has no waybill under this number`);
  const waybill = listed.find((entry) => isRecord(entry) && normalizeTrackingNumber(text(entry, 'number', 64)) === number);
  if (!isRecord(waybill)) throw new IndeterminateError(PROVIDER, `${PROVIDER} returned another waybill`);
  return waybill;
}

/**
 * Fastgo's history for one waybill, newest first. `list` holds the scans, each a `remark` and a
 * `time` on a clock without a zone: the scans come from its warehouses and from customs in China,
 * so each keeps its wall clock. `expressalias` and `expressno` name the courier of the last leg
 * and its number; the courier becomes the delivery carrier when its own rules take the number.
 * `issign`, `deliverystatus` and each scan's `flag`, which the tracking page does not show, are
 * not read.
 */
export function parseFastgo(payload: unknown, raw: string): CarrierResult {
  const number = normalizeFastgoNumber(raw);
  const waybill = waybillOf(payload, number);
  const rows = waybill.list ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_SCANS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid history`);
  const leg = lastLeg(waybill, number);
  const seen = new Set<string>();
  const scans: { event: CarrierEvent; index: number }[] = [];
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan`);
    const description = text(row, 'remark', 300);
    if (!description) continue;
    const local_time = wallClock(text(row, 'time', 40));
    const key = JSON.stringify([local_time, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = fastgoStage(description);
    scans.push({ index, event: {
      local_time, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!scans.length) {
    throw new NoHistoryError(PROVIDER, `${PROVIDER} lists the waybill without scans`, { reason: 'listed',
      ...(leg.delivery_carrier ? { deliveryCarrier: leg.delivery_carrier, deliveryTrackingNumber: leg.delivery_tracking_number } : {}) });
  }
  // Newest first, as the tracking page shows them; scans on one clock keep the reply's order, reversed.
  const events = scans.sort((left, right) => (left.event.local_time! < right.event.local_time! ? 1
    : left.event.local_time! > right.event.local_time! ? -1 : right.index - left.index)).map(({ event }) => event);
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...leg,
    events,
  };
}
