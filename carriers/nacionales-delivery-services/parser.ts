import { DateTime } from 'luxon';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { map } from './status.js';

export const provider = 'nacionales-delivery-services';
type TimedEvent = CarrierEvent & { time: string; stage?: Stage };

function codeOf(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Z_]{3,40}$/.test(value) ? value : undefined;
}

export function parseTracking(response: unknown, number: string): CarrierResult {
  if (!isRecord(response) || response.success !== true || !isRecord(response.data)) {
    throw new SchemaError(provider, 'Nacionales Delivery Services did not return a shipment record');
  }
  const data = response.data;
  if (typeof data.trackingNumber !== 'string' || data.trackingNumber.trim().toUpperCase() !== number) {
    throw new IndeterminateError(provider, 'Nacionales Delivery Services did not return the requested shipment');
  }

  const seen = new Map<string, TimedEvent>();
  for (const row of Array.isArray(data.history) ? data.history : []) {
    if (!isRecord(row) || typeof row.created_at !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(row.created_at)) continue;
    const code = codeOf(row.status);
    const time = DateTime.fromISO(row.created_at, { setZone: true }).toISO();
    if (!code || !time) continue;

    const movement = map.get(code);
    seen.set(JSON.stringify([time, code]), {
      time, provider_code: code, description: movement?.description ?? code,
      ...(movement && { stage: movement.stage, stage_source: 'carrier_map' }),
    });
  }
  const history = [...seen.values()].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  const statusCode = codeOf(data.currentStatus);
  const summary = statusCode ? map.get(statusCode) : undefined;
  const stage = summary?.stage ?? (!statusCode ? history[0]?.stage : undefined);
  const currentScan = statusCode ? history.find(event => event.provider_code === statusCode) : history[0];
  if (!statusCode && !currentScan) {
    throw new IndeterminateError(provider, 'Nacionales Delivery Services listed the shipment without a status', { reason: 'listed' });
  }
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: summary?.description ?? statusCode ?? currentScan?.description,
    ...(currentScan && { last_update: currentScan.time }),
    ...(history.length ? { events: history } : { summary_only: true }),
  };
}
