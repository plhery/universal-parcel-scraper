import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, trackingLanguageStage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { stageForStatus } from './status.js';

export const provider = 'lalji-mulji-transport';
const zone = 'Asia/Kolkata';

function parseScan(raw: unknown, reference: string) {
  if (!isRecord(raw)) throw new SchemaError(provider, 'Invalid Lalji Mulji movement record');
  if (cleanScalar(raw.waybillNumber).toUpperCase() !== reference.toUpperCase()) {
    throw new IndeterminateError(provider, 'Lalji Mulji returned a different lorry receipt');
  }
  const code = clean(raw.status, 100);
  const clock = zonedTime(raw.dateTime, 'EEE, dd MMM yyyy HH:mm:ss', zone, { locale: 'en' });
  if (!code || !clock) throw new SchemaError(provider, 'Lalji Mulji movement lacks a status or a valid clock');
  const location = clean(raw.branchName, 150);
  const mapped = stageForStatus(code);
  const stage = mapped ?? trackingLanguageStage(code);
  const event: CarrierEvent = {
    time: clock.iso, provider_code: code, description: code,
    ...(location ? { location } : {}),
    ...(stage ? { stage, stage_source: mapped ? 'carrier_map' : 'wording:language' } : {}),
  };
  const weight = typeof raw.actualWeight === 'number' && Number.isFinite(raw.actualWeight) && raw.actualWeight > 0
    ? raw.actualWeight : undefined;
  return { event, stage, weight, timestamp: clock.timestamp };
}

export function parseTracking(body: unknown, reference: string): CarrierResult {
  if (!isRecord(body)) throw new SchemaError(provider, 'Invalid Lalji Mulji tracking reply');
  if (!Array.isArray(body.serviceResult)) {
    if (body.serviceResult == null && isRecord(body.message) && body.message.messageId === 21
      && /^No records found\s*!?$/i.test(clean(body.message.description))) throw new NotFoundError(provider);
    throw new SchemaError(provider, 'Lalji Mulji reply lacks movement records');
  }
  if (!body.serviceResult.length) throw new NoHistoryError(provider);

  const scans = body.serviceResult.map(row => parseScan(row, reference)).reverse()
    .sort((a, b) => b.timestamp - a.timestamp);
  const latest = scans[0]!;
  const stage = latest.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: latest.event.stage_source } : {}),
    ...(latest.weight ? { weight_kg: latest.weight } : {}),
    provider_code: latest.event.provider_code,
    last_status_text: latest.event.description ?? null,
    last_update: latest.event.time ?? null,
    events: scans.map(scan => scan.event),
  };
}
