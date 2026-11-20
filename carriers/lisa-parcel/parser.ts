import { DateTime } from 'luxon';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { scanStages, summaryStages } from './status.js';

export const provider = 'lisa-parcel';

function localDay(value: unknown): string | undefined {
  const [day] = clean(value).split(',', 1);
  const date = DateTime.fromFormat(day ?? '', 'M/d/yyyy', { zone: 'utc' });
  return date.isValid ? date.toISODate() : undefined;
}

function movement(row: Record<string, unknown>): (CarrierEvent & { stage: Stage }) | undefined {
  const status = clean(row.status);
  const entry = [...scanStages].find(([wording]) => status === wording || status.startsWith(wording + ' '));
  const date = localDay(row.date);
  if (!entry || !date) return undefined;
  const [description, stage] = entry;
  const location = clean(row.location);
  const showLocation = location && status === description + ' ' + location && !hasPrivateDeliveryDetails(location);
  return {
    description, local_time: date, stage, stage_source: 'carrier_map',
    ...(showLocation && { location }),
  };
}

export function parseTracking(body: string, number: string, status: number): CarrierResult {
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'Lisa Parcel did not return tracking JSON');
  }
  if (!isRecord(reply)) throw new SchemaError(provider, 'Lisa Parcel omitted the shipment data');
  if (status === 404 && reply.code === 'NOT_FOUND') throw new NotFoundError(provider);
  const identities = [reply.trackingNumber, reply.vendorTrackingNumber, reply.relayTrackingNumber];
  if (!identities.some(identity => clean(identity).toUpperCase() === number)) {
    throw new IndeterminateError(provider, 'Lisa Parcel did not return the requested tracking number');
  }
  if (!Array.isArray(reply.history)) throw new SchemaError(provider, 'Lisa Parcel omitted the tracking history');

  const events = (reply.history as unknown[]).flatMap(row => {
    const event = isRecord(row) ? movement(row) : undefined;
    return event ? [event] : [];
  }).reverse();
  const summary = clean(reply.status);
  const explicitStage = summaryStages.get(summary.toUpperCase());
  const current = explicitStage ?? (reply.isPreShipping === true ? 'registered' : events[0]?.stage);
  if (!current) throw new IndeterminateError(provider, 'Lisa Parcel listed the shipment without dated movements', { reason: 'listed' });
  const summaryEvent = events.find(event => event.stage === current);
  return {
    status: languageStageStatus(current), current_stage: current, current_stage_source: 'carrier_map',
    ...(summary && !hasPrivateDeliveryDetails(summary) && { last_status_text: summary }),
    ...(summaryEvent && { last_update_local: summaryEvent.local_time }),
    ...(events.length ? { events } : { summary_only: true }),
  };
}
