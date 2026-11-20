import { DateTime } from 'luxon';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { statuses } from './status.js';

export const provider = 'ag-cargo-india';
type Movement = { event: CarrierEvent & { stage?: Stage }; sortTime: number };

function codeOf(value: unknown): string {
  return typeof value === 'string' ? clean(value).toUpperCase() : '';
}

function parseTime(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return undefined;
  const stamp = DateTime.fromISO(value, { zone: 'UTC', setZone: true });
  if (!stamp.isValid) return undefined;
  const fields = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    ? { time: stamp.toISO({ suppressMilliseconds: true }) } : { local_time: stamp.toFormat("yyyy-MM-dd'T'HH:mm:ss") };
  return { fields, sortTime: stamp.toMillis() };
}

export function parseTracking(response: unknown, number: string): CarrierResult {
  if (!isRecord(response) || response.success !== true || !isRecord(response.data)) {
    throw new SchemaError(provider, 'AG Cargo did not return a shipment record');
  }
  const data = response.data;
  if (codeOf(data.lrnum) !== number) {
    throw new IndeterminateError(provider, 'AG Cargo did not return the requested LR');
  }

  const movements = new Map<string, Movement>();
  for (const row of Array.isArray(data.wbns) ? data.wbns : []) {
    if (!isRecord(row) || codeOf(row.lrnum) !== number) continue;
    const code = codeOf(row.status);
    const mapped = statuses.get(code);
    if (!mapped) continue;
    const stamp = parseTime(row.scan_timestamp) ?? (code === 'MANIFESTED' ? parseTime(row.manifested_date) : undefined);
    if (!stamp) continue;
    const terminal = typeof row.location === 'string' ? clean(row.location) : '';
    const location = /^[A-Z][A-Z0-9._/-]{2,65} \([A-Z .-]{2,40}\)$/i.test(terminal) && !hasPrivateDeliveryDetails(terminal)
      ? terminal : undefined;
    const event = {
      ...stamp.fields, provider_code: code, description: mapped.description,
      ...(location && { location }),
      ...(mapped.stage && { stage: mapped.stage, stage_source: 'carrier_map' }),
    };
    movements.set(JSON.stringify([stamp.fields, code, location]), { event, sortTime: stamp.sortTime });
  }
  const history = [...movements.values()].sort((a, b) => b.sortTime - a.sortTime).map(item => item.event);
  const summaryCode = codeOf(data.status);
  const summary = statuses.get(summaryCode);
  const latest = history[0];
  if (!summary && !latest) {
    throw new IndeterminateError(provider, 'AG Cargo listed the LR without a recognized status', { reason: 'listed' });
  }
  const currentScan = summary ? history.find(event => event.provider_code === summaryCode) : latest;
  return {
    status: summary?.stage ? languageStageStatus(summary.stage) : 'unknown',
    ...(summary?.stage && { current_stage: summary.stage, current_stage_source: 'carrier_map' }),
    last_status_text: summary?.description ?? latest?.description,
    ...(currentScan?.time && { last_update: currentScan.time }),
    ...(currentScan?.local_time && { last_update_local: currentScan.local_time }),
    ...(history.length ? { events: history } : { summary_only: true }),
  };
}
