import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { cleanScalar } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { inTimeStage, statusMap } from './status.js';

export const PROVIDER = 'In Time Croatia';
export const CARRIER = 'intime-hr';
export const IN_TIME_MAX_BYTES = 256_000;
// The tracking form's example: HR and twelve digits.
const NUMBER = /^HR\d{12}$/;
// "2026-06-30T10:03:19.087": the scan's wall clock in Croatia, without an offset.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,7})?)?$/;
const CODE = /^[A-Z]{1,4}\d{1,4}$/;
// "Preuzeto (Picked Up)": the Croatian wording, then the English one in parentheses.
const BILINGUAL = /^(.*?)\s*\(([^()]+)\)\s*$/;
// The API's answer for a number it does not hold.
const NOT_FOUND = 'Tracking number not found';
const MAX_SCANS = 200;

/** An In Time Croatia shipment number, as its tracking form takes it: HR and twelve digits. */
export function normalizeInTimeNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'In Time Croatia shipment numbers are HR and twelve digits');
  return number;
}

function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > maxLength * 4) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

function wallClock(value: string): string {
  const parts = CLOCK.exec(value);
  const day = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  if (!parts || !day) throw new SchemaError(PROVIDER, `${PROVIDER} returned a scan without a readable time`);
  return `${day}T${parts[4]}:${parts[5]}:${parts[6] ?? '00'}`;
}

/** The English half of a bilingual label, as the English page shows it, or the label whole. */
function englishWording(label: string): string {
  return BILINGUAL.exec(label)?.[2]?.trim() || label;
}

/**
 * The shipment of a reply. The API answers a shipment with its route and `events`, and a number
 * it does not hold with HTTP 404 and `{"error": "Tracking number not found"}`; any other error is
 * no answer about the number.
 */
function shipmentOf(payload: unknown, status: number): Record<string, unknown> {
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  if (payload.error !== undefined) {
    if (status === 404 && payload.error === NOT_FOUND) throw new NotFoundError(PROVIDER, `${PROVIDER} has no shipment under this number`);
    throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  }
  if (status !== 200 || !Array.isArray(payload.events)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  return payload;
}

/**
 * In Time's history for one number, newest first. Each row has a code, a bilingual label, a time
 * on Croatia's clock without a zone and the depot's town. The route's towns are the sender's and
 * recipient's and are not kept; the destination's country is.
 */
export function parseInTime(payload: unknown, raw: string, status = 200): CarrierResult {
  normalizeInTimeNumber(raw);
  const shipment = shipmentOf(payload, status);
  const rows = shipment.events as unknown[];
  if (rows.length > MAX_SCANS) throw new SchemaError(PROVIDER, `${PROVIDER} returned too many scans`);
  const seen = new Set<string>();
  const scans: { index: number; event: CarrierEvent & { local_time: string } }[] = [];
  rows.forEach((row, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan`);
    const code = text(row, 'statusCode', 20);
    if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid status code`);
    const description = englishWording(text(row, 'statusLabel', 200)) || code;
    if (!description) return;
    const local_time = wallClock(text(row, 'eventDate', 40));
    const location = text(row, 'location', 120);
    const key = JSON.stringify([local_time, code, description, location]);
    if (seen.has(key)) return;
    seen.add(key);
    const staged = inTimeStage(code, description);
    scans.push({ index, event: {
      local_time, description, ...(code ? { provider_code: code } : {}), ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER, `${PROVIDER} lists the shipment without scans`, { reason: 'listed' });
  const events = scans.sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || b.index - a.index)
    .map(({ event }) => event);
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  const destination = countryCode(typeof shipment.shipToCountry === 'string' ? shipment.shipToCountry : undefined);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time,
    expected_delivery: null,
    ...(destination ? { destination_country: destination } : {}),
    events,
  };
}
