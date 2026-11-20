import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { eventStage, summaryFor } from './status.js';

export const provider = 'freight-club';
export const referencePattern = /^[A-Za-z0-9_-]{3,80}$/;

function parseEvent(row: unknown) {
  if (!isRecord(row)) throw new SchemaError(provider, 'Invalid Freight Club activity');
  const wording = clean(row.Activity);
  const clock = explicitOffsetTime(row.Date);
  if (!wording || !clock) throw new SchemaError(provider, 'Freight Club activity has no wording or offset timestamp');
  const stage = eventStage(wording);
  const location = [clean(row.City), clean(row.ProvinceState)].filter(part => part && part !== '-').join(', ');
  const event: CarrierEvent = {
    time: clock.iso,
    ...(!hasPrivateDeliveryDetails(wording) ? { description: wording } : {}),
    ...(location ? { location } : {}),
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  };
  return { event, stage, timestamp: clock.timestamp };
}

export function parseTracking(body: unknown, reference: string): CarrierResult {
  if (!isRecord(body) || body.TrackingAttempted !== true || typeof body.TrackingFound !== 'boolean') {
    throw new SchemaError(provider, 'Invalid Freight Club tracking reply');
  }
  const tracking = clean(body.TrackingNumber);
  if (!body.TrackingFound) {
    const empty = body.Details == null || (Array.isArray(body.Details) && body.Details.length === 0);
    if (tracking.toUpperCase() !== reference.toUpperCase() || !empty) {
      throw new IndeterminateError(provider, 'Freight Club did not confirm the requested reference as missing');
    }
    throw new NotFoundError(provider);
  }
  if (!referencePattern.test(tracking) || (body.Details != null && !Array.isArray(body.Details))) {
    throw new SchemaError(provider, 'Freight Club reply lacks a valid carrier reference or activity list');
  }
  const matched = tracking.toUpperCase() === reference.toUpperCase();
  // Booking lookups return the partner's identifier. A partner lookup echoes the identifier itself.
  if (!matched && !/^FCT\d+$/i.test(reference)) {
    throw new IndeterminateError(provider, 'Freight Club replied with a different carrier reference');
  }

  const scans = ((body.Details ?? []) as unknown[]).map(parseEvent)
    .sort((a, b) => b.timestamp - a.timestamp);
  const summaryCode = clean(body.LastStatusSimplified);
  const summary = summaryFor(summaryCode);
  const stage = summary?.stage ?? scans.find(scan => scan.stage)?.stage;
  if (!scans.length && !summary) throw new NoHistoryError(provider);
  const delivered = stage === 'delivered'
    ? scans.find(scan => scan.stage === 'delivered')?.event.time ?? explicitOffsetTime(body.TrackingDeliveryDate)?.iso
    : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    ...(summaryCode ? { provider_code: summaryCode } : {}),
    ...(!matched ? { delivery_tracking_number: tracking } : {}),
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(!scans.length ? { summary_only: true } : {}),
    last_status_text: summary?.description ?? scans[0]?.event.description ?? null,
    last_update: scans[0]?.event.time ?? null,
    events: scans.map(scan => scan.event),
  };
}
