import { DateTime } from 'luxon';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { statuses } from './status.js';

export const provider = 'ddx-global-express';
type Movement = { event: CarrierEvent & { stage?: Stage }; sortTime: number };

function readClock(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value)) return undefined;
  const stamp = DateTime.fromISO(value, { zone: 'UTC', setZone: true });
  if (!stamp.isValid) return undefined;
  const clock = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    ? { time: stamp.toISO({ suppressMilliseconds: true }) } : { local_time: stamp.toFormat("yyyy-MM-dd'T'HH:mm:ss") };
  return { clock, sortTime: stamp.toMillis() };
}

function codeOf(value: unknown): string {
  return typeof value === 'string' ? clean(value).toUpperCase().replaceAll(' ', '_') : '';
}

export function parseTracking(response: unknown, number: string): CarrierResult {
  if (!isRecord(response) || response.success !== true || !isRecord(response.data)) {
    throw new SchemaError(provider, 'DDX Global Express did not return a shipment record');
  }
  const data = response.data;
  if (typeof data.trackingNumber !== 'string' || clean(data.trackingNumber).toUpperCase() !== number) {
    throw new IndeterminateError(provider, 'DDX Global Express did not return the requested parcel');
  }
  const found = new Map<string, Movement>();
  for (const row of Array.isArray(data.events) ? data.events : []) {
    if (!isRecord(row)) continue;
    const code = codeOf(row.status);
    const wording = statuses.get(code);
    const stamp = readClock(row.time);
    if (!wording || !stamp) continue;
    found.set(JSON.stringify([code, stamp.clock]), {
      event: {
        ...stamp.clock, provider_code: code, description: wording.label,
        ...(wording.stage && { stage: wording.stage, stage_source: 'carrier_map' }),
      },
      sortTime: stamp.sortTime,
    });
  }
  const history = [...found.values()].sort((a, b) => b.sortTime - a.sortTime).map(item => item.event);
  const code = codeOf(data.status);
  const summary = statuses.get(code);
  const latest = history[0];
  if (!summary && !latest) {
    throw new IndeterminateError(provider, 'DDX Global Express listed the parcel without a recognized status', { reason: 'listed' });
  }
  const currentEvent = summary ? history.find(event => event.provider_code === code) : latest;
  const updated = readClock(data.lastUpdatedAt)?.clock ?? currentEvent;
  const stage = summary ? summary.stage : latest?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: summary?.label ?? latest?.description,
    ...(updated?.time && { last_update: updated.time }),
    ...(updated?.local_time && { last_update_local: updated.local_time }),
    ...(history.length ? { events: history } : { summary_only: true }),
  };
}
