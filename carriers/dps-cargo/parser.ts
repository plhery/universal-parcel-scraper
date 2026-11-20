import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { scanStage } from './status.js';

export const provider = 'dps-cargo';

export function parseTracking(body: string, number: string, httpStatus: number): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'DPS Cargo requires verification');
  }
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'DPS Cargo did not return tracking JSON');
  }
  if (httpStatus === 404 && isRecord(data) && data.ok === false && typeof data.message === 'string'
      && /^Nomor resi tidak ditemukan\./i.test(data.message)) {
    throw new NotFoundError(provider);
  }
  if (httpStatus !== 200 || !isRecord(data) || data.ok !== true || !isRecord(data.shipment)) {
    throw new SchemaError(provider, 'DPS Cargo omitted its shipment result');
  }
  const { shipment } = data;
  if (shipment.resi !== number) throw new IndeterminateError(provider, 'DPS Cargo did not confirm the full shipment number');
  if (!Array.isArray(shipment.events)) throw new SchemaError(provider, 'DPS Cargo omitted movement history');

  const events = shipment.events.map(row => {
    if (!isRecord(row)) throw new SchemaError(provider, 'DPS Cargo returned an invalid movement');
    const code = clean(row.status).toUpperCase();
    const when = clean(row.occurredAt);
    const date = /(?:Z|[+-]\d{2}:\d{2})$/i.test(when) ? DateTime.fromISO(when, { setZone: true }) : null;
    if (!code || !date?.isValid) throw new SchemaError(provider, 'DPS Cargo returned an invalid movement code or instant');
    const location = clean(row.city);
    const stage = scanStage(code);
    return {
      time: date.toUTC().toISO(), description: code, provider_code: code,
      ...(location && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  }).sort((first, second) => second.time.localeCompare(first.time));

  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'DPS Cargo listed the shipment without dated movements', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update: latest.time, events,
  };
}
