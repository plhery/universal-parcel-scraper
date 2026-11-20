import { DateTime } from 'luxon';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { blueDartHandoff, stages } from './status.js';

export const provider = 'sfl-worldwide';
type Movement = CarrierEvent & { description: string; stage: Stage };

function reference(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return typeof value === 'string' ? clean(value).toUpperCase() : '';
}

function movement(value: unknown): { event: Movement; sortTime: number } | undefined {
  if (!isRecord(value) || typeof value.Comments !== 'string' || typeof value.ActualDate !== 'string') return;
  const raw = clean(value.Comments);
  const description = /^Shipment has been connected via Blue Dart(?: under AWB\b|$)/i.test(raw) ? blueDartHandoff : raw;
  const stage = stages.get(description);
  if (!stage || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}.*)?$/.test(value.ActualDate)
    || value.ActualDate.startsWith('0001-')) return;
  const clock = DateTime.fromISO(value.ActualDate, { zone: 'UTC', setZone: true });
  if (!clock.isValid) return;
  const timestamp = /(?:Z|T.*[+-]\d{2}:?\d{2})$/.test(value.ActualDate)
    ? { time: clock.toISO({ suppressMilliseconds: true }) }
    : { local_time: value.ActualDate.includes('T') ? clock.toFormat("yyyy-MM-dd'T'HH:mm:ss") : clock.toISODate() };
  return {
    event: { ...timestamp, description, stage, stage_source: 'carrier_map' }, sortTime: clock.toMillis(),
  };
}

export function parseTracking(response: unknown, number: string): CarrierResult {
  const envelope = isRecord(response) && isRecord(response.user) ? response.user : undefined;
  const result: unknown = envelope?.success === true && Array.isArray(envelope.resultPass) ? envelope.resultPass[0] : undefined;
  const data = isRecord(result) ? result.spgetshipmentbytracking : undefined;
  if (!isRecord(data) || typeof data.success !== 'boolean' || !Array.isArray(data.data)) {
    throw new SchemaError(provider, 'SFL Worldwide did not return a shipment lookup result');
  }
  if (!data.success) {
    if (data.count === 0 && data.data.length === 0 && data.message === 'No shipment found for tracking number: ' + number) {
      throw new NotFoundError(provider);
    }
    throw new SchemaError(provider, 'SFL Worldwide returned an unrecognized tracking error');
  }

  const shipments = (data.data as unknown[]).filter(row => isRecord(row) && reference(row.trackingnumber) === number);
  const shipment: unknown = shipments[0];
  if (shipments.length !== 1 || !isRecord(shipment)) {
    throw new IndeterminateError(provider, 'SFL Worldwide did not identify one shipment with the requested number');
  }

  const tracking: unknown[] = Array.isArray(shipment.trackingdetails) ? shipment.trackingdetails : [];
  const updates = tracking.flatMap(row => {
    const event = movement(row);
    return event ? [event] : [];
  }).sort((a, b) => b.sortTime - a.sortTime).map(update => update.event);
  const raw = typeof shipment.transactionstatus === 'string' ? clean(shipment.transactionstatus) : '';
  const summary = hasPrivateDeliveryDetails(raw) ? '' : raw;
  const latest = summary ? updates.find(event => event.description === summary) : updates[0];
  const stage = summary ? stages.get(summary) : latest?.stage;
  const statusText = summary || latest?.description;
  if (!statusText) {
    throw new IndeterminateError(provider, 'SFL Worldwide listed the shipment without a public status', { reason: 'listed' });
  }
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: statusText,
    ...(latest?.time && { last_update: latest.time }),
    ...(latest?.local_time && { last_update_local: latest.local_time }),
    ...(updates.length ? { events: updates } : { summary_only: true }),
  };
}
