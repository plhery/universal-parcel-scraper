import { DateTime } from 'luxon';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { stages } from './status.js';

export const provider = 'quickship-canada';

function textOf(value: unknown): string {
  return typeof value === 'string' ? clean(value) : '';
}

function deliveryInstant(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return undefined;
  return DateTime.fromISO(value, { setZone: true }).toISO({ suppressMilliseconds: true }) ?? undefined;
}

export function parseTracking(response: unknown, number: string): CarrierResult {
  if (!isRecord(response) || response.success !== true || !Array.isArray(response.data)) {
    throw new SchemaError(provider, 'QuickShip did not return a shipment list');
  }
  const packages = response.data.filter(isRecord).filter(parcel => (
    textOf(parcel.awb).toUpperCase() === number || textOf(parcel.lmAwb).toUpperCase() === number
  ));
  if (!packages.length) {
    throw new IndeterminateError(provider, 'QuickShip did not return the requested waybill');
  }

  const movements = new Map<string, CarrierEvent>();
  for (const parcel of packages) {
    for (const row of Array.isArray(parcel.events) ? parcel.events : []) {
      if (!isRecord(row)) continue;
      const code = textOf(row.statusCode);
      const description = textOf(row.statusRemark);
      if (code === '308' || !description || hasPrivateDeliveryDetails(description) || /^(?:expected|estimated|scheduled)\b/i.test(description)) continue;
      const stamp = DateTime.fromFormat(textOf(row.eventDate), 'dd-MM-yyyy hh:mm a', { locale: 'en', zone: 'UTC' });
      if (!stamp.isValid) continue;

      const clock = stamp.toFormat("yyyy-MM-dd'T'HH:mm");
      const stage = stages.get(code);
      movements.set(JSON.stringify([code, clock, description]), {
        local_time: clock, description, ...(code && { provider_code: code }),
        ...(stage && { stage, stage_source: 'carrier_map' }),
      });
    }
  }
  const history = [...movements.values()].sort((a, b) => (b.local_time ?? '').localeCompare(a.local_time ?? ''));
  const first = packages[0]!;
  const firstCode = textOf(first.statusCode);
  const commonCode = firstCode && packages.every(parcel => textOf(parcel.statusCode) === firstCode) ? firstCode : '';
  const firstStatus = textOf(first.status);
  const description = firstStatus && !hasPrivateDeliveryDetails(firstStatus)
    && packages.every(parcel => textOf(parcel.status) === firstStatus) ? firstStatus : '';
  if (!description && !history.length) {
    throw new IndeterminateError(provider, 'QuickShip listed the waybill without any status', { reason: 'listed' });
  }
  const stage = stages.get(commonCode);
  const deliveries = packages.map(parcel => deliveryInstant(parcel.deliveryDate))
    .filter((instant): instant is string => instant !== undefined);
  const deliveredAt = stage === 'delivered' && deliveries.length === packages.length
    ? deliveries.sort((a, b) => Date.parse(b) - Date.parse(a))[0] : undefined;
  const currentScan = commonCode ? history.find(event => event.provider_code === commonCode) : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    ...(commonCode && { provider_code: commonCode }),
    ...(description && { last_status_text: description }),
    ...(deliveredAt ? { last_update: deliveredAt, delivered_at: deliveredAt } : (
      currentScan && { last_update_local: currentScan.local_time }
    )),
    ...(history.length ? { events: history } : { summary_only: true }),
  };
}
