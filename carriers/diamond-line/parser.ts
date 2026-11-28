import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { cleanScalar } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { diamondLineStage, statusMap } from './status.js';

export const PROVIDER = 'Diamond Line';
export const CARRIER = 'diamond-line';
export const DIAMOND_LINE_MAX_BYTES = 128_000;
// The tracker takes a PRO number; the public example is nine digits.
const NUMBER = /^\d{6,12}$/;
// "2024-01-25": the scan's day.
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// "15:12", or "  :  " for a scan dated by its day alone.
const CLOCK = /^(\d{2}):(\d{2})$/;
const BLANK_CLOCK = /^[\s:]*$/;
// What the shipment's `pallets` and `weight` hold: a count, and pounds.
const WEIGHT = /^\d{1,6}(?:\.\d{1,3})?$/;
const POUNDS_TO_KG = 0.453_592_37;
const MAX_SCANS = 200;
// The lifecycle the tracker gives a rate quote, which is no shipment.
const QUOTE = 'quote';
// A history row's place column holds a status for a trailer on the road, not a place.
const NOT_A_PLACE = /^in transit$/i;
// What the record holds as the signatory when the proof of delivery is a scanned page.
const NO_SIGNATORY = /^see scanned pod$/i;

/** A Diamond Line PRO number, as the tracking widget sends it: digits, without spaces or hyphens. */
export function normalizeDiamondLineNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Diamond Line PRO numbers are six to twelve digits');
  return number;
}

function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid ${key}`);
  if (typeof value === 'string' && value.length > maxLength * 4) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

/** A scan's wall clock: its day, with its time of day when the row has one. */
function wallClock(row: Record<string, unknown>): string {
  const day = DAY.exec(text(row, 'date', 20));
  if (!day || !calendarDay(Number(day[1]), Number(day[2]), Number(day[3]))) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned a scan without its day`);
  }
  const rawClock = typeof row.time === 'string' ? row.time : '';
  if (BLANK_CLOCK.test(rawClock)) return day[0];
  const clock = CLOCK.exec(rawClock.trim());
  if (!clock || Number(clock[1]) > 23 || Number(clock[2]) > 59) throw new SchemaError(PROVIDER, `${PROVIDER} returned an impossible scan clock`);
  return `${day[0]}T${clock[1]}:${clock[2]}:00`;
}

/**
 * The shipment the reply holds for the number asked. The tracking API answers a shipment as
 * `shipment` and `history`; a number it does not hold as WordPress's error object, code
 * `tracking_not_found`, with the number in its message. Any other error is a failure.
 */
function shipmentOf(payload: unknown, number: string): { shipment: Record<string, unknown>; history: unknown } {
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  if (!isRecord(payload.shipment)) {
    if (payload.code === 'tracking_not_found' && typeof payload.message === 'string'
      && new RegExp(`(?:^|\\s)${number}$`).test(payload.message.trim())) {
      throw new NotFoundError(PROVIDER, `${PROVIDER} has no shipment under this PRO number`);
    }
    if (typeof payload.code === 'string') throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  }
  if (normalizeTrackingNumber(text(payload.shipment, 'pro_number', 40)) !== number) {
    throw new IndeterminateError(PROVIDER, `${PROVIDER} returned another shipment`);
  }
  return { shipment: payload.shipment, history: payload.history };
}

function weightKg(shipment: Record<string, unknown>): number | null {
  const pounds = text(shipment, 'weight', 16);
  const value = WEIGHT.test(pounds) ? Number(pounds) : 0;
  return value > 0 ? Math.round(value * POUNDS_TO_KG * 1000) / 1000 : null;
}

/**
 * Diamond Line's history for one PRO number, newest first as the reply lists it. Each row is a
 * wording (`code`), a day, a time of day on the terminal's clock without a zone, or blanks for a
 * row dated by its day alone, and `remarks`, the terminal or town. The shipment's `status` is a
 * free text summary the history repeats, and `lifecycle` the badge the page shows; a record whose
 * lifecycle is `Quote` is a rate quote, not a shipment.
 */
export function parseDiamondLine(payload: unknown, raw: string): CarrierResult {
  const number = normalizeDiamondLineNumber(raw);
  const { shipment, history } = shipmentOf(payload, number);
  if (text(shipment, 'lifecycle', 40).toLowerCase() === QUOTE) {
    throw new NoHistoryError(PROVIDER, `${PROVIDER} holds a rate quote, not a shipment, under this number`, { reason: 'no_history' });
  }
  const rows = history ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_SCANS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid history`);
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan`);
    const description = text(row, 'code', 200);
    if (!description) continue;
    const local_time = wallClock(row);
    const place = text(row, 'remarks', 120);
    const location = NOT_A_PLACE.test(place) ? '' : place;
    const key = JSON.stringify([local_time, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = diamondLineStage(description);
    events.push({
      local_time, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER, `${PROVIDER} lists the shipment without scans`, { reason: 'listed' });
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  const signatory = text(shipment, 'received_by', 80);
  const weight = weightKg(shipment);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(signatory && !NO_SIGNATORY.test(signatory) ? { signed_by: signatory } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    events,
  };
}
