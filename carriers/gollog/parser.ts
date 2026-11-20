import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { gollogStage } from './status.js';

export const PROVIDER = 'GOLLOG';

type Scan = CarrierEvent & { time: string; description: string; provider_code: string; stage?: Stage };

export function gollogWaybill(raw: string): string {
  const number = raw.length <= 32 ? raw.replace(/[\s-]/g, '') : '';
  if (!/^127\d{8}$/.test(number)) throw new InvalidInputError(PROVIDER, 'GOLLOG takes an eleven-digit waybill beginning with 127');
  return number;
}

function readJson(body: string): unknown {
  if (/<title>\s*(?:Just a moment|Access Denied|Attention Required)|cf-chl-|g-recaptcha|cf-turnstile/i.test(body)) {
    throw new ChallengeError(PROVIDER, 'GOLLOG returned a verification page');
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new SchemaError(PROVIDER, 'GOLLOG returned invalid tracking JSON');
  }
}

function readScans(rows: unknown[], homeDelivery: unknown): Scan[] {
  const events: Scan[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'GOLLOG returned an invalid scan');
    const code = clean(row.code, 18);
    // A manifest lists a planned transport. The guest tracker omits it from the timeline.
    if (code === 'MAN') continue;
    const description = clean(row.message, 400) || clean(row.codeDescription, 160);
    const clock = explicitOffsetTime(row.date);
    const location = clean(row.station, 100);
    if (!code || !description || !clock) throw new SchemaError(PROVIDER, 'GOLLOG returned an incomplete scan');
    const stage = gollogStage(code, homeDelivery);
    events.push({ time: clock.iso, description, provider_code: code,
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }
  return events.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

export function parseGollogReply(body: string, number: string): CarrierResult {
  const data = readJson(body);
  if (!isRecord(data)) throw new SchemaError(PROVIDER, 'GOLLOG returned no tracking object');
  if (data.unAuthorizedRequest === true) throw new ChallengeError(PROVIDER, 'GOLLOG turned down the guest lookup');
  if (data.success === false || data.error) throw new IndeterminateError(PROVIDER, 'GOLLOG returned an unsuccessful lookup');
  if (data.success !== true || !Array.isArray(data.result) || data.result.length !== 1) {
    throw new SchemaError(PROVIDER, 'GOLLOG returned no unique waybill');
  }
  const shipment: unknown = data.result[0];
  if (!isRecord(shipment) || !isRecord(shipment.header) || typeof shipment.header.code !== 'string'
    || typeof shipment.found !== 'boolean' || !Array.isArray(shipment.events) || shipment.events.length > 500) {
    throw new SchemaError(PROVIDER, 'GOLLOG returned an invalid waybill');
  }
  if (shipment.header.code !== number) throw new IndeterminateError(PROVIDER, 'GOLLOG returned another waybill');
  if (!shipment.found) {
    if (shipment.events.length) throw new SchemaError(PROVIDER, 'GOLLOG returned scans for an unknown waybill');
    throw new NotFoundError(PROVIDER);
  }

  const events = readScans(shipment.events, shipment.isHomeDelivery);
  const newest = events[0];
  const summary = isRecord(shipment.lastStatus) ? shipment.lastStatus : {};
  const code = clean(summary.code, 18);
  const wording = clean(summary.description, 400);
  const cancelled = shipment.isCancelled === true;
  if (!newest && !wording) throw new NoHistoryError(PROVIDER, 'GOLLOG lists the waybill without scans', { reason: 'listed' });
  const stage = cancelled ? 'exception' : newest?.stage ?? gollogStage(code, shipment.isHomeDelivery);
  const time = (cancelled ? explicitOffsetTime(shipment.cancellationDateTime)?.iso : undefined) ?? newest?.time ?? null;
  const service = clean(shipment.header.serviceName, 120);
  const weight = shipment.header.weight;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: cancelled && wording ? wording : newest?.description ?? wording,
    last_update: time,
    ...(!newest && code ? { provider_code: code } : {}),
    ...(service ? { service_name: service } : {}),
    ...(typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? { weight_kg: weight } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
