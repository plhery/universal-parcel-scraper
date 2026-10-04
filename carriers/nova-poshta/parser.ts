import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult, CarrierStatus } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';

const PROVIDER = 'Nova Poshta';
const STAGES: Readonly<Record<string, Stage>> = {
  '1': 'registered', '2': 'exception', '4': 'in_transit', '41': 'in_transit', '5': 'in_transit', '6': 'in_transit',
  '7': 'ready_for_pickup', '8': 'ready_for_pickup', '9': 'delivered', '10': 'delivered', '11': 'delivered',
  '14': 'in_transit', '101': 'out_for_delivery', '102': 'exception', '103': 'exception', '104': 'in_transit',
  '105': 'exception', '106': 'delivered', '108': 'exception',
};
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
