import { DateTime } from 'luxon';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { statuses } from './status.js';

export const provider = 'sb-express-bangladesh';

function stageFor(value: unknown) {
  return typeof value === 'string' ? statuses.get(clean(value).toLowerCase().replaceAll('_', ' ')) : undefined;
}

export function parseTracking(response: unknown, number: string): CarrierResult {
  if (!isRecord(response) || response.success !== true || !isRecord(response.shipment)) {
    throw new SchemaError(provider, 'SB Express did not return a shipment record');
  }
  const shipment = response.shipment;
  if (typeof shipment.tracking_code !== 'string' || clean(shipment.tracking_code).toUpperCase() !== number) {
    throw new IndeterminateError(provider, 'SB Express did not return the requested parcel');
  }

  const movements = new Map<string, CarrierEvent & { stage: Stage }>();
  for (const row of Array.isArray(shipment.logs) ? shipment.logs : []) {
    if (!isRecord(row) || typeof row.time !== 'string') continue;
    const wording = stageFor(row.status);
    const clock = DateTime.fromFormat(clean(row.time), 'LLL d, yyyy h:mm a', { locale: 'en-US', zone: 'UTC' });
    if (!wording || !clock.isValid) continue;

    const detail = typeof row.location === 'string' ? clean(row.location) : '';
    const terminal = /^[\p{L} .'-]{2,60} (?:Hub|Dispatch Station)$/iu.test(detail) && !hasPrivateDeliveryDetails(detail)
      ? detail : undefined;
    const localTime = clock.toFormat("yyyy-MM-dd'T'HH:mm:ss");
    movements.set(JSON.stringify([wording.label, localTime, terminal]), {
      local_time: localTime, description: wording.label, stage: wording.stage, stage_source: 'carrier_map',
      ...(terminal && { location: terminal }),
    });
  }
  const history = [...movements.values()].sort((a, b) => (b.local_time ?? '').localeCompare(a.local_time ?? ''));
  const summary = stageFor(shipment.raw_status) ?? stageFor(shipment.status);
  const latest = history[0];
  const stage = summary?.stage ?? latest?.stage;
  if (!stage) {
    throw new IndeterminateError(provider, 'SB Express listed the parcel without a usable status', { reason: 'listed' });
  }
  const currentScan = summary ? history.find(event => event.description === summary.label) : latest;
  return {
    status: languageStageStatus(stage),
    current_stage: stage,
    current_stage_source: 'carrier_map',
    last_status_text: summary?.label ?? latest?.description,
    ...(currentScan && { last_update_local: currentScan.local_time }),
    ...(history.length ? { events: history } : { summary_only: true }),
  };
}
