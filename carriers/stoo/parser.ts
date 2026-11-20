import { DateTime } from 'luxon';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { stages } from './status.js';

export const provider = 'stoo';
type Movement = { event: CarrierEvent & { stage?: Stage }; sortTime: number };

function readClock(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value)) return undefined;
  const stamp = DateTime.fromISO(value, { zone: 'UTC', setZone: true });
  if (!stamp.isValid) return undefined;
  const clock = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    ? { time: stamp.toISO({ suppressMilliseconds: true }) }
    : { local_time: stamp.toFormat("yyyy-MM-dd'T'HH:mm:ss") };
  return { clock, sortTime: stamp.toMillis() };
}

export function parseTracking(response: unknown, number: string): CarrierResult {
  if (!isRecord(response) || response.isSuccess !== true || !isRecord(response.data)) {
    throw new SchemaError(provider, 'STOO did not return a shipment record');
  }
  const data = response.data;
  if (typeof data.regNo !== 'string' || clean(data.regNo).toUpperCase() !== number) {
    throw new IndeterminateError(provider, 'STOO did not return the requested shipment');
  }

  const movements = new Map<string, Movement>();
  for (const row of Array.isArray(data.trackingHistory) ? data.trackingHistory : []) {
    if (!isRecord(row) || row.isPassed !== true || typeof row.status !== 'number' || typeof row.statusDesc !== 'string') continue;
    const description = clean(row.statusDesc);
    const stamp = readClock(row.dateTime);
    if (!description || !stamp) continue;

    const stage = stages.get(row.status);
    const code = String(row.status);
    movements.set(JSON.stringify([code, stamp.clock]), {
      event: {
        ...stamp.clock, provider_code: code, description,
        ...(stage && { stage, stage_source: 'carrier_map' }),
      },
      sortTime: stamp.sortTime,
    });
  }
  const history = [...movements.values()].sort((a, b) => b.sortTime - a.sortTime).map(item => item.event);
  const current = isRecord(data.currentStatus) ? data.currentStatus : undefined;
  const code = typeof current?.code === 'number' ? current.code : undefined;
  const wording = typeof current?.description === 'string' ? clean(current.description) : '';
  const latest = history[0];
  if (!wording && !latest) {
    throw new IndeterminateError(provider, 'STOO listed the shipment without a status', { reason: 'listed' });
  }
  const stage = code === undefined ? latest?.stage : stages.get(code);
  const updated = code === undefined ? latest : history.find(event => event.provider_code === String(code));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: wording || latest?.description,
    ...(updated?.time && { last_update: updated.time }),
    ...(updated?.local_time && { last_update_local: updated.local_time }),
    ...(history.length ? { events: history } : { summary_only: true }),
  };
}
