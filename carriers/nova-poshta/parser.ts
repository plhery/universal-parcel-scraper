import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import { explicitOffsetTime, zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';

const PROVIDER = 'Nova Poshta';
const STAGES: Readonly<Record<string, Stage>> = {
  '1': 'registered', '2': 'exception', '4': 'in_transit', '41': 'in_transit', '5': 'in_transit', '6': 'in_transit',
  '7': 'ready_for_pickup', '8': 'ready_for_pickup', '9': 'delivered', '10': 'delivered', '11': 'delivered',
  '14': 'in_transit', '101': 'out_for_delivery', '102': 'exception', '103': 'exception', '104': 'in_transit',
  '105': 'exception', '106': 'delivered', '108': 'exception',
};
const MOVEMENT_STAGES: Readonly<Record<string, Stage>> = {
  ...STAGES, '4': 'accepted', '80': 'in_transit', '81': 'in_transit',
  '115': 'customs', '120': 'in_transit', '121': 'in_transit', '122': 'in_transit', '199': 'customs',
};
const DELIVERY_REFERENCES = new Set(['NPU', 'NPU_Redirecting']);
function movementTime(value: unknown): string | undefined {
  const text = clean(value, 64);
  // Luxon normalizes impossible offsets; those must remain unresolved.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.test(text)
    ? explicitOffsetTime(text)?.iso : undefined;
}
function statusOf(stage: string | undefined): CarrierStatus {
  return stage === 'delivered' ? 'delivered' : stage === 'out_for_delivery' ? 'out_for_delivery'
    : ['returned', 'exception', 'failed_attempt'].includes(stage ?? '') ? 'exception'
      : ['registered', 'pending'].includes(stage ?? '') ? 'pending' : stage ? 'in_transit' : 'unknown';
}
export function normalizeNovaPoshtaNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  // Domestic families named by the official tracking client's router.
  if (!/^(?:1\d{13}|(?:20[4678]|590|595)\d{11}|(?:21|51)\d{12})$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Nova Poshta requires a Ukrainian waybill number');
  }
  return number;
}
function receiptTime(value: unknown): string | undefined {
  const text = clean(value, 64);
  const format = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? 'yyyy-MM-dd HH:mm:ss'
    : /^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/.test(text) ? 'dd-MM-yyyy HH:mm:ss' : null;
  return format ? zonedTime(text, format, 'Europe/Kyiv')?.iso : undefined;
}
export function parseNovaPoshta(payload: unknown, raw: string): CarrierResult {
  const number = normalizeNovaPoshtaNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.errors) || !Array.isArray(payload.data)) throw new SchemaError(PROVIDER);
  if (payload.success === false || payload.errors.length) throw new IndeterminateError(PROVIDER, 'Nova Poshta could not return shipment details');
  if (payload.success !== true || payload.data.length !== 1 || !isRecord(payload.data[0])) throw new SchemaError(PROVIDER);
  const item = payload.data[0];
  if (typeof item.Number !== 'string' || normalizeTrackingNumber(item.Number) !== number) throw new SchemaError(PROVIDER, 'Nova Poshta returned a different shipment');
  const code = clean(item.StatusCode, 32), description = clean(item.Status, 1000);
  if (!code || !description) throw new SchemaError(PROVIDER, 'Nova Poshta returned no status');
  if (code === '3') throw new NotFoundError(PROVIDER);
  const stage = STAGES[code];
  const status: CarrierStatus = stage === 'delivered' ? 'delivered' : stage === 'out_for_delivery' ? 'out_for_delivery'
    : stage === 'exception' ? 'exception' : stage === 'registered' ? 'pending' : stage ? 'in_transit' : 'unknown';
  // DateCreated is booking, TrackingUpdateDate is metadata refresh. Neither is
  // an instant for the current status. RecipientDateTime explicitly records receipt.
  const delivered = stage === 'delivered' ? receiptTime(item.RecipientDateTime) : undefined;
  return { status, ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: description, last_update: delivered ?? null, ...(delivered ? { delivered_at: delivered } : {}),
    timezone: 'Europe/Kyiv', summary_only: true, events: [] };
}

/** The current public site's movement feed, including carrier-bound rerouting. */
export function parseNovaPoshtaHistory(payload: unknown, raw: string): CarrierResult {
  const number = normalizeNovaPoshtaNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER);
  if (isRecord(payload.errors)) throw new IndeterminateError(PROVIDER, 'Nova Poshta could not return movement history');
  if (typeof payload.number !== 'string' || normalizeTrackingNumber(payload.number) !== number) {
    throw new SchemaError(PROVIDER, 'Nova Poshta returned a different shipment');
  }
  if (!Array.isArray(payload.tracking) || payload.tracking.length > 1000) throw new SchemaError(PROVIDER);
  const parcelNumbers = new Set([number]);
  if (payload.parcels !== undefined) {
    if (!Array.isArray(payload.parcels) || payload.parcels.length > 1000) throw new SchemaError(PROVIDER);
    for (const parcel of payload.parcels) {
      if (!isRecord(parcel) || typeof parcel.number !== 'string' || !parcel.number.trim() || parcel.number.length > 64) throw new SchemaError(PROVIDER);
      parcelNumbers.add(normalizeTrackingNumber(parcel.number));
    }
  }
  // The website lists redirected waybills separately from return and payment
  // references. Only a declared delivery reference may extend this history.
  for (const field of ['alternativeNumbersGW', 'alternativeNumbersGWNew']) {
    const references = payload[field];
    if (references === undefined) continue;
    if (!Array.isArray(references) || references.length > 100) throw new SchemaError(PROVIDER);
    for (const reference of references) {
      if (!isRecord(reference) || typeof reference.name !== 'string' || typeof reference.number !== 'string'
        || !reference.number.trim() || reference.number.length > 64) throw new SchemaError(PROVIDER);
      if (DELIVERY_REFERENCES.has(reference.name)) parcelNumbers.add(normalizeTrackingNumber(reference.number));
    }
  }
  let current: CarrierEvent | undefined;
  const events: CarrierEvent[] = payload.tracking.flatMap(row => {
    if (!isRecord(row) || typeof row.parcel_number !== 'string' || !parcelNumbers.has(normalizeTrackingNumber(row.parcel_number))) {
      throw new SchemaError(PROVIDER, 'Nova Poshta returned mixed shipment history');
    }
    if (typeof row.event_status !== 'string' || !['passed', 'now', 'future'].includes(row.event_status)) throw new SchemaError(PROVIDER, 'Nova Poshta returned an invalid movement state');
    // A dated future rail point is a plan, not a completed scan.
    if (row.event_status === 'future') return [];
    const description = clean(row.event_name, 1000), code = clean(row.code, 32);
    if (!description || !code) throw new SchemaError(PROVIDER, 'Nova Poshta returned an empty movement');
    const timeText = clean(row.date, 64), time = movementTime(timeText);
    const stage = MOVEMENT_STAGES[code];
    const location = clean(row.settlement_name, 200);
    const event: CarrierEvent = { description, provider_code: code, ...(time ? { time } : timeText ? { provider_time_text: timeText } : {}),
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    if (row.event_status === 'now') {
      if (current) throw new IndeterminateError(PROVIDER, 'Nova Poshta returned multiple current movements');
      current = event;
    }
    return [event];
  });
  if (!events.length) throw new IndeterminateError(PROVIDER, 'Nova Poshta returned no completed movement history');
  // The official tracker reverses its oldest-first path for display. Preserve
  // that order when any clock cannot be resolved.
  events.reverse();
  if (events.every(event => event.time)) events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));
  const unique = events.filter((event, index) => events.findIndex(other => JSON.stringify(other) === JSON.stringify(event)) === index);
  const latest = current ?? unique[0]!;
  const status = statusOf(latest.stage);
  const expected = movementTime(payload.scheduled_delivery_date);
  const weight = typeof payload.total_weight === 'number' && Number.isFinite(payload.total_weight) && payload.total_weight > 0 ? payload.total_weight : undefined;
  return { status, ...(latest.stage ? { current_stage: latest.stage, current_stage_source: latest.stage_source } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null,
    ...(status === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(expected ? { expected_delivery: expected } : {}), ...(weight ? { weight_kg: weight } : {}),
    timezone: 'Europe/Kyiv', events: unique.slice(0, 100) };
}
