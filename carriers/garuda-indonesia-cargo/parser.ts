import { DateTime } from 'luxon';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { actions } from './status.js';

export interface IcmsCarrier {
  id: string;
  name: string;
  prefix: string;
}

export const garuda = { id: 'garuda-indonesia-cargo', name: 'Garuda Indonesia Cargo', prefix: '126' } as const;
export const provider = garuda.id;

function readEvent(row: Record<string, unknown>): CarrierEvent | undefined {
  const code = typeof row.Action === 'string' ? row.Action.trim().toUpperCase() : '';
  if (!/^[A-Z][A-Z0-9_-]{1,15}$/.test(code)) return undefined;
  const status = actions.get(code);
  const location = typeof row.Station === 'string' && /^[A-Z]{3}$/.test(row.Station.trim()) ? row.Station.trim() : undefined;
  const date = typeof row.createdon === 'string'
    ? DateTime.fromFormat(row.createdon.trim(), 'dd-MMM-yyyy HH:mm', { locale: 'en', zone: 'UTC' })
    : undefined;
  return {
    description: status?.description ?? code,
    provider_code: code,
    ...(status && { stage: status.stage, stage_source: 'carrier_map' }),
    ...(location && { location }),
    ...(date?.isValid && { local_time: date.toFormat("yyyy-MM-dd'T'HH:mm") }),
  };
}

export function parseIcmsTracking(data: unknown, serial: string, carrier: IcmsCarrier): CarrierResult {
  const { id, name, prefix } = carrier;
  if (!isRecord(data) || !Array.isArray(data.Table0) || !Array.isArray(data.Table1) || !Array.isArray(data.Table3)) {
    throw new SchemaError(id, name + ' omitted its public waybill tables');
  }
  const matchesWaybill = (row: unknown): row is Record<string, unknown> =>
    isRecord(row) && typeof row.AWBNo === 'string' && [serial, prefix + '-' + serial, prefix + serial].includes(row.AWBNo.trim());
  const summary = data.Table0.find(matchesWaybill);
  if (!summary) throw new IndeterminateError(id, name + ' did not confirm the requested waybill');

  const latestRow = data.Table1.find(matchesWaybill);
  const latest = latestRow && readEvent(latestRow);
  const rows = data.Table3.filter(matchesWaybill);
  // The provider's sequence spans station clocks in different time zones.
  // The Latest Event table identifies the current status independently of those clocks.
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of [...(latestRow ? [latestRow] : []), ...rows.reverse()]) {
    const event = readEvent(row);
    if (!event) continue;
    const key = JSON.stringify([event.provider_code, event.local_time, event.location]);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  const current = latest ?? events[0];
  const code = current?.provider_code ?? (typeof summary.AWBStatus === 'string' ? summary.AWBStatus.trim().toUpperCase() : '');
  const status = actions.get(code);
  if (!status && !current) {
    throw new IndeterminateError(id, name + ' listed the waybill without shipment activity', { reason: 'listed' });
  }
  return {
    status: status ? languageStageStatus(status.stage) : 'unknown',
    ...(status && { current_stage: status.stage, current_stage_source: 'carrier_map' }),
    last_status_text: status?.description ?? code,
    provider_code: code,
    ...(current?.local_time && { last_update_local: current.local_time }),
    events,
  };
}

export function parseTracking(data: unknown, serial: string): CarrierResult {
  return parseIcmsTracking(data, serial, garuda);
}
