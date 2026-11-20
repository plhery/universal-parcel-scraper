import { DateTime } from 'luxon';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { stages } from './status.js';

export const provider = 'leschaco';

type Movement = CarrierEvent & { description: string; stage?: Stage };

function referenceKey(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().toUpperCase().replace(/^ALRB[ -]?/, '') : undefined;
}

function movement(row: unknown): Movement | undefined {
  if (!isRecord(row) || row.hasActual !== true || typeof row.eventTypeId !== 'number'
    || typeof row.eventTypeName !== 'string' || typeof row.date !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(row.date)) return undefined;
  const timestamp = DateTime.fromISO(row.date, { zone: 'UTC', setZone: true });
  const description = clean(row.eventTypeName);
  if (!timestamp.isValid || !description || hasPrivateDeliveryDetails(description)) return undefined;

  const stage = stages.get(row.eventTypeId);
  const port = typeof row.locationUnLocode === 'string' && /^[A-Z]{2}[A-Z0-9]{3}$/.test(row.locationUnLocode)
    ? row.locationUnLocode : '';
  const place = typeof row.location === 'string' ? clean(row.location) : '';
  const location = port && (place && !hasPrivateDeliveryDetails(place) && /^[\p{L}\p{M} .,()’-]{1,65}$/u.test(place) ? place : port);
  const offset = /(?:Z|[+-]\d{2}:\d{2})$/.test(row.date);
  return {
    description, provider_code: String(row.eventTypeId),
    ...(offset ? { time: timestamp.toISO({ suppressMilliseconds: true }) }
      : { local_time: timestamp.toISO({ includeOffset: false, suppressMilliseconds: true }) }),
    ...(location && { location }),
    ...(stage && { stage, stage_source: 'carrier_map' }),
  };
}

export function parseTracking(data: unknown, number: string): CarrierResult {
  if (!Array.isArray(data)) throw new SchemaError(provider, 'Leschaco did not return a shipment list');
  if (!data.length) throw new NotFoundError(provider);
  const records = (data as unknown[]).filter(isRecord).filter(row =>
    isRecord(row.shipmentHeaderDto) && referenceKey(row.shipmentHeaderDto.shipmentNumber) === referenceKey(number));
  const matching = records[0];
  if (!matching || records.length !== 1) {
    throw new IndeterminateError(provider, 'Leschaco did not return a unique matching shipment');
  }
  if (!Array.isArray(matching.shipmentEventsDto)) throw new SchemaError(provider, 'Leschaco omitted the movement history');

  // Visible lists the movements in order from origin to destination.
  const events = (matching.shipmentEventsDto as unknown[]).map(movement)
    .filter((event): event is Movement => event !== undefined).reverse();
  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Leschaco listed the bill without any actual movements', { reason: 'listed' });
  const stage = latest.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update: latest.time, last_update_local: latest.local_time, events,
  };
}
