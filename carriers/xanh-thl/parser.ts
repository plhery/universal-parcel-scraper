import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { scanStages } from './status.js';

export const provider = 'xanh-thl';

export function rejectChallenge(body: string): void {
  if (/<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(body)) {
    throw new ChallengeError(provider, 'Xanh THL requires verification');
  }
}

export function parseTracking(body: string, number: string): CarrierResult {
  rejectChallenge(body);
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'Xanh THL did not return tracking JSON');
  }
  if (!isRecord(data) || data.success !== true || !isRecord(data.data)) {
    throw new SchemaError(provider, 'Xanh THL omitted the tracking result');
  }
  const result = data.data;
  if (result.found === false) throw new NotFoundError(provider);
  if (result.found !== true || !Array.isArray(result.data)) {
    throw new SchemaError(provider, 'Xanh THL omitted the shipment list');
  }
  const rows: unknown[] = result.data;
  if (!rows.length || (rows.length === 1 && isRecord(rows[0]) && rows[0].Id === 0 && rows[0].Code === '0')) {
    throw new NotFoundError(provider);
  }
  const shipment = rows[0];
  if (rows.length !== 1 || !isRecord(shipment) || clean(shipment.Code).toUpperCase() !== number.toUpperCase()) {
    throw new IndeterminateError(provider, 'Xanh THL did not confirm the exact waybill');
  }
  const history = [shipment.ldh, shipment.history, shipment.History, shipment.details,
    shipment.TrackingHistory, shipment.trackingHistory, shipment.histories, shipment.Ldh].find(Array.isArray) as unknown[] | undefined;
  const events = (history ?? []).flatMap(row => {
    if (!isRecord(row)) return [];
    const description = clean(row.StatusName);
    const clock = DateTime.fromFormat(clean(row.DateTime), 'd-M-yyyy H:mm', { zone: 'utc' });
    if (!description || hasPrivateDeliveryDetails(description) || !clock.isValid) return [];
    const location = clean(row.POName);
    const stage = scanStages.get(description);
    return [{
      description, local_time: clock.toFormat("yyyy-MM-dd'T'HH:mm"),
      ...(location && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    }];
  }).sort((first, second) => second.local_time.localeCompare(first.local_time));
  const current = clean(shipment.StatusName);
  const label = current && !hasPrivateDeliveryDetails(current) ? current : events[0]?.description;
  const stage = scanStages.get(label ?? '');
  if (!label) {
    throw new IndeterminateError(provider, 'Xanh THL listed the shipment without a status or dated movements', { reason: 'listed' });
  }
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: label,
    ...(events.length ? { events, last_update_local: events[0]?.local_time } : { summary_only: true }),
  };
}
