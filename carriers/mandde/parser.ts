import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { scanStages } from './status.js';

export const provider = 'mandde';

function localClock(value: unknown): string | undefined {
  // The official page treats the SQL serialization as its wall clock, including values ending in Z.
  const clock = clean(value).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?Z?$/);
  if (!clock) return undefined;
  const local = clock[1] + 'T' + clock[2];
  return DateTime.fromISO(local, { zone: 'utc' }).isValid ? local : undefined;
}

export function parseTracking(body: string, number: string): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'MANDDE requires verification');
  }
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'MANDDE did not return tracking JSON');
  }
  if (!Array.isArray(data)) throw new SchemaError(provider, 'MANDDE omitted the movement list');
  const rows: unknown[] = data;
  if (!rows.length) throw new NotFoundError(provider);
  const events = rows.map(row => {
    if (!isRecord(row)) throw new SchemaError(provider, 'MANDDE returned an invalid movement');
    if (clean(row.Cons_Guias).toUpperCase() !== number.toUpperCase()) {
      throw new IndeterminateError(provider, 'MANDDE returned a different guide');
    }
    const code = clean(row.Cod_EstadoG);
    const label = clean(row.Nom_EstadoG);
    const localTime = localClock(row.Fec_Proceso);
    if (!localTime || !/^[A-Z]{2,6}$/.test(code)) {
      throw new SchemaError(provider, 'MANDDE omitted a valid movement clock or code');
    }
    const location = clean(row.Nom_Ciudad);
    const stage = scanStages.get(code);
    return {
      description: label && !hasPrivateDeliveryDetails(label) ? label : code,
      local_time: localTime,
      provider_code: code,
      ...(location && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  });
  events.reverse().sort((first, second) => second.local_time.localeCompare(first.local_time));
  const latest = events[0]!;
  const stage = latest.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
