import { DateTime } from 'luxon';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { stages } from './status.js';

export const provider = 'saco-shipping-line';

type Shipment = { id: string; code: number; status: string };
type Movement = CarrierEvent & { local_time: string; description: string; stage: Stage };

function shipmentId(value: unknown): string {
  const id = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  return /^\d{1,15}$/.test(id) ? id : '';
}

export function parseSearch(reply: unknown, reference: string): Shipment {
  if (!isRecord(reply) || reply.success !== true || !Array.isArray(reply.data)) {
    throw new SchemaError(provider, 'SACO Shipping Line omitted its bill search result');
  }
  if (!reply.data.length && reply.message === 'No shipments found for the provided reference.') {
    throw new NotFoundError(provider);
  }
  const matches = reply.data.filter(isRecord).filter(row =>
    row.bl_number === reference || (isRecord(row.container_info) && row.container_info.bill_of_lading === reference));
  const row = matches[0];
  const id = shipmentId(row?.shipment_id);
  if (!row || !id || matches.some(match => shipmentId(match.shipment_id) !== id)) {
    throw new IndeterminateError(provider, 'SACO Shipping Line did not identify a single matching bill');
  }
  const description = isRecord(row.formatted_status) && typeof row.formatted_status.status_text === 'string'
    ? clean(row.formatted_status.status_text) : '';
  return { id, code: Number(row.status_code), status: description };
}

function parseMovement(row: unknown): Movement | undefined {
  if (!isRecord(row) || typeof row.status_code !== 'number' || typeof row.status_name !== 'string'
    || typeof row.date_time !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.date_time)) return undefined;
  const stage = stages.get(row.status_code);
  const description = clean(row.status_name);
  if (!stage || !description || hasPrivateDeliveryDetails(description)) return undefined;
  const time = DateTime.fromSQL(row.date_time, { zone: 'UTC' });
  if (!time.isValid) return undefined;
  const location = typeof row.un_code === 'string' && /^[A-Z]{2}[A-Z0-9]{3}$/.test(row.un_code) ? row.un_code : '';
  return {
    provider_code: String(row.status_code), description, local_time: time.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    ...(location && { location }), stage, stage_source: 'carrier_map',
  };
}

export function parseTracking(reply: unknown, shipment: Shipment): CarrierResult {
  if (!isRecord(reply) || reply.success !== true || !Array.isArray(reply.data)) {
    throw new SchemaError(provider, 'SACO Shipping Line omitted its event history');
  }
  if (shipmentId(reply.shipment_id) !== shipment.id) {
    throw new IndeterminateError(provider, 'SACO Shipping Line returned the history of a different shipment');
  }
  const distinct = new Map<string, Movement>();
  for (const row of reply.data as unknown[]) {
    const event = parseMovement(row);
    if (event) distinct.set(JSON.stringify([event.provider_code, event.local_time, event.location]), event);
  }
  const events = [...distinct.values()];
  const latest = events[0];
  const summaryStage = stages.get(shipment.code);
  const summaryText = shipment.status && !hasPrivateDeliveryDetails(shipment.status) ? shipment.status : undefined;
  const stage = latest?.stage ?? summaryStage;
  if (!stage) throw new IndeterminateError(provider, 'SACO Shipping Line listed the bill without an observed status', { reason: 'listed' });
  return {
    status: languageStageStatus(stage), current_stage: stage, current_stage_source: 'carrier_map',
    last_status_text: latest?.description ?? summaryText, last_update_local: latest?.local_time, events,
  };
}
