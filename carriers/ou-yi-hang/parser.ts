import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { movementStages, shipmentStages } from './status.js';

export const provider = 'ou-yi-hang';

export function parseTracking(body: string, number: string): CarrierResult {
  if (/<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(body)) {
    throw new ChallengeError(provider, 'Ou Yi Hang requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'Ou Yi Hang did not return tracking JSON');
  }
  if (!isRecord(reply) || reply.code !== 0 || reply.message !== 'success') {
    throw new SchemaError(provider, 'Ou Yi Hang omitted a successful tracking reply');
  }
  if (reply.data === null) throw new NotFoundError(provider);
  if (!isRecord(reply.data) || !Array.isArray(reply.data.details)) {
    throw new SchemaError(provider, 'Ou Yi Hang omitted shipment details');
  }

  const shipment = reply.data;
  if (clean(shipment.trackingNo).toUpperCase() !== number) {
    throw new IndeterminateError(provider, 'Ou Yi Hang did not confirm the full waybill number');
  }
  const events = reply.data.details.flatMap<CarrierEvent>(row => {
    if (!isRecord(row)) throw new SchemaError(provider, 'Ou Yi Hang returned an invalid movement');
    const description = clean(row.description);
    const location = clean(row.location);
    if (hasPrivateDeliveryDetails(description) || hasPrivateDeliveryDetails(location)) return [];
    const clock = clean(row.time).replace(' ', 'T');
    const offset = clean(row.gmtOffset);
    const isoClock = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
    const isoOffset = /^[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00)$/;
    if (!description || !isoClock.test(clock) || (offset && !isoOffset.test(offset))) {
      throw new SchemaError(provider, 'Ou Yi Hang returned invalid movement text or time');
    }
    const date = DateTime.fromISO(clock + offset, { setZone: true, zone: 'UTC' });
    if (!date.isValid) throw new SchemaError(provider, 'Ou Yi Hang returned an invalid movement date');
    const stage = movementStages.get(description);
    return [{
      ...(offset ? { time: date.toUTC().toISO() } : { local_time: clock }),
      description,
      ...(location && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    }];
  });
  // The portal supplies reverse scan order. Keep that order when an offset is absent.
  const hasInstants = events.every(event => event.time !== undefined);
  if (hasInstants) events.sort((first, second) => (second.time ?? '').localeCompare(first.time ?? ''));

  const code = clean(shipment.status);
  const summary = clean(shipment.statusName);
  const safeSummary = hasPrivateDeliveryDetails(summary) ? '' : summary;
  const latest = events[0];
  const text = safeSummary || latest?.description;
  if (!text) throw new IndeterminateError(provider, 'Ou Yi Hang listed the waybill without a readable status', { reason: 'listed' });
  const stage = shipmentStages.get(code);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    ...(code && { provider_code: code }),
    last_status_text: text,
    ...(hasInstants && latest?.time && { last_update: latest.time }),
    ...(!latest && { summary_only: true }),
    events,
  };
}
