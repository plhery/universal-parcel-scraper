import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { administrativeScans, scanStages } from './status.js';

export const provider = 'transportes-chevalier';

function guideId(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value);
  return /^\d{1,15}$/.test(text) ? text.replace(/^0+(?=\d)/, '') : undefined;
}

export function parseTracking(body: string, number: string, status: number): CarrierResult {
  if (/<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(body)) {
    throw new ChallengeError(provider, 'Transportes Chevalier requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'Transportes Chevalier did not return tracking JSON');
  }
  const expected = guideId(number);
  if (status === 404 && expected && isRecord(reply) && clean(reply.message) === 'No existe la guia ' + expected) {
    throw new NotFoundError(provider);
  }
  if (status !== 200 || !isRecord(reply) || reply.success !== true || !isRecord(reply.data) || !Array.isArray(reply.data_track)) {
    throw new SchemaError(provider, 'Transportes Chevalier omitted the guide or its tracking history');
  }
  if (!expected || guideId(reply.data.tagid) !== expected) {
    throw new IndeterminateError(provider, 'Transportes Chevalier returned a different guide');
  }

  const events = new Map<string, CarrierEvent>();
  for (const row of reply.data_track as unknown[]) {
    if (!isRecord(row)) throw new SchemaError(provider, 'Transportes Chevalier returned an invalid movement');
    if (guideId(row.tagid) !== expected) {
      throw new IndeterminateError(provider, 'Transportes Chevalier returned a movement for a different guide');
    }
    const description = clean(row.type_state_name);
    const code = description.toUpperCase();
    if (administrativeScans.has(code) || hasPrivateDeliveryDetails(description)) continue;
    const clock = clean(row.dete_time);
    const timestamp = DateTime.fromFormat(clock, 'yyyy-MM-dd HH:mm:ss', { zone: 'utc' });
    if (!description || !timestamp.isValid) throw new SchemaError(provider, 'Transportes Chevalier returned an invalid scan clock or label');
    const localTime = timestamp.toFormat("yyyy-MM-dd'T'HH:mm:ss");
    const city = clean(row.city_name);
    const location = hasPrivateDeliveryDetails(city) ? '' : city;
    const stage = scanStages.get(code);
    events.set(JSON.stringify([localTime, code, location]), {
      local_time: localTime, description,
      ...(location && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    });
  }

  const history = [...events.values()].sort((first, second) => (second.local_time ?? '').localeCompare(first.local_time ?? ''));
  const latest = history[0];
  if (!latest) throw new IndeterminateError(provider, 'Transportes Chevalier listed the guide without dated movements', { reason: 'listed' });
  const stage = scanStages.get((latest.description ?? '').toUpperCase());
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events: history,
  };
}
