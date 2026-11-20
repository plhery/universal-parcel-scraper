import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { spedireCodeStage, spedireRowStage, spedireStatusText } from './status.js';

export const PROVIDER = 'spedire';
// A shipment and its rows are a few kilobytes.
export const SPEDIRE_MAX_BYTES = 512 * 1024;

// The tracker takes Spedire's shipment reference or the label number of the courier it booked.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// "2025-11-29 14:02:16": the Italian wall clock of a row, without an offset.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const CODE = /^[A-Z]$/;
const COUNTRY = /^[A-Z]{2}$/;
const PARTNER_NUMBER = /^[A-Z0-9]{4,40}$/;
const MAX_ROWS = 300;

/** A number for Spedire's tracker: a shipment reference or a courier's label number, in letters and digits. */
export function normalizeSpedireNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter a Spedire shipment reference or the courier tracking number on its label');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

function text(record: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = record[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maxLength * 4) return invalid(`Spedire returned an invalid ${key}`);
  return clean(value, maxLength);
}

function clockOf(value: string): string {
  const parts = CLOCK.exec(value);
  const date = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  if (!parts || !date || Number(parts[1]) < 2001) return invalid('Spedire returned an invalid row time');
  return `${date}T${parts[4]}:${parts[5]}:${parts[6] ?? '00'}`;
}

/**
 * The shipment in one reply of `POST /api/public/tracking`, or undefined for the
 * tracker's `{"success":false}`: no shipment under the code on that platform.
 */
export function spedireShipment(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload) || typeof payload.success !== 'boolean') return invalid('Spedire returned an unreadable reply');
  if (!payload.success) return undefined;
  if (!isRecord(payload.shipment)) return invalid('Spedire returned a reply without its shipment');
  return payload.shipment;
}

/**
 * Reads the reply for one shipment. Its names, cities, postcodes and pickup
 * bookings stay behind, as does the sender's country; the rows keep their Italian wall clock.
 */
export function parseSpedire(payload: unknown, number: string): CarrierResult {
  const shipment = spedireShipment(payload);
  if (!shipment || !isRecord(payload)) return invalid('Spedire returned no shipment to read');
  const reference = text(shipment, 'reference', 60).toUpperCase();
  const tracker = text(shipment, 'tracker', 60).toUpperCase().replace(/\s+/g, '');
  // The tracker looks a code up whole, as a reference or as the label number.
  if (reference !== number && tracker !== number) throw new IndeterminateError(PROVIDER, 'Spedire answered for another shipment');
  const code = text(shipment, 'last_status', 4);
  if (code && !CODE.test(code)) return invalid('Spedire returned an invalid status');
  const exception = shipment.exception_code;
  if (exception !== undefined && exception !== null && !Number.isSafeInteger(exception)) return invalid('Spedire returned an invalid exception');

  const rows: unknown = payload.tracking ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return invalid('Spedire returned an invalid history');
  const seen = new Set<string>();
  const events = rows.map((row, index) => {
    if (!isRecord(row)) return invalid('Spedire returned an invalid row');
    const description = text(row, 'status', 500);
    if (!description) return invalid('Spedire returned a row without wording');
    const location = text(row, 'place', 200);
    const staged = spedireRowStage(description);
    const event: CarrierEvent & { local_time: string } = { local_time: clockOf(text(row, 'data', 40)), description,
      ...(location ? { location } : {}), ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
    return { index, event };
  }).filter(({ event }) => {
    const key = JSON.stringify([event.local_time, event.description, event.location ?? '']);
    return !seen.has(key) && Boolean(seen.add(key));
  }).sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || a.index - b.index).map(({ event }) => event);

  // The tracker heads the page with the shipment's status letter, which leads the rows.
  const coded = code ? spedireCodeStage(code, typeof exception === 'number' ? exception : undefined) : undefined;
  const newest = events[0];
  const staged = events.find((event) => event.stage);
  const stage = (coded ?? staged?.stage) as Stage | undefined;
  if (!newest && !coded) return invalid('Spedire returned a shipment without a status or rows');
  const destination = text(shipment, 'receiver_country', 4);
  const handoff = tracker && tracker !== number && PARTNER_NUMBER.test(tracker) ? tracker : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: coded ? 'carrier_map' : staged!.stage_source! } : {}),
    ...(code ? { provider_code: code } : {}),
    last_status_text: (code && spedireStatusText(code, typeof exception === 'number' ? exception : undefined)) || newest?.description || null,
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(COUNTRY.test(destination) ? { destination_country: destination } : {}),
    ...(handoff ? { delivery_tracking_number: handoff } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
