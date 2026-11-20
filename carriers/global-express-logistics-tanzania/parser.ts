import { DateTime } from 'luxon';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { statuses } from './status.js';

export const provider = 'global-express-logistics-tanzania';
type TimedEvent = CarrierEvent & { time: string; stage?: Stage };

function codeOf(value: unknown): string {
  return typeof value === 'string' ? clean(value).toLowerCase().replaceAll(' ', '_') : '';
}

export function parseTracking(response: unknown, number: string): CarrierResult {
  if (!isRecord(response) || response.ok !== true || !isRecord(response.parcel)) {
    throw new SchemaError(provider, 'Global Express Logistics Tanzania did not return a parcel record');
  }
  const parcel = response.parcel;
  if (typeof parcel.trackingNumber !== 'string' || clean(parcel.trackingNumber).toUpperCase() !== number) {
    throw new IndeterminateError(provider, 'Global Express Logistics Tanzania did not return the requested parcel');
  }
  const movements = new Map<string, TimedEvent>();
  for (const item of Array.isArray(parcel.history) ? parcel.history : []) {
    if (!isRecord(item) || typeof item.timestamp !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(item.timestamp)) continue;
    const code = codeOf(item.status);
    const word = statuses.get(code);
    const time = DateTime.fromISO(item.timestamp, { setZone: true }).toISO({ suppressMilliseconds: true });
    if (!word || !time) continue;
    movements.set(JSON.stringify([code, time]), {
      time, provider_code: code, description: word.label,
      ...(word.stage && { stage: word.stage, stage_source: 'carrier_map' }),
    });
  }
  const history = [...movements.values()].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  const currentCode = codeOf(parcel.status);
  const summary = statuses.get(currentCode);
  const latest = history[0];
  if (!summary && !latest) {
    throw new IndeterminateError(provider, 'Global Express Logistics Tanzania listed the parcel without a recognized status', { reason: 'listed' });
  }
  const stage = summary ? summary.stage : latest?.stage;
  const currentScan = summary ? history.find(event => event.provider_code === currentCode) : latest;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: summary?.label ?? latest?.description,
    ...(currentScan && { last_update: currentScan.time }),
    ...(history.length ? { events: history } : { summary_only: true }),
  };
}
