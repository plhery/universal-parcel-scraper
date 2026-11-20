import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { administrativeScans, scanStages } from './status.js';

export const provider = 'certipostal';

function guideId(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value);
  return /^\d{1,15}$/.test(text) ? text.replace(/^0+(?=\d)/, '') : undefined;
}

export function parseTracking(body: string, number: string, httpStatus: number): CarrierResult {
  if (/<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource|verify (?:that )?you are human/i.test(body)) {
    throw new ChallengeError(provider, 'Certipostal requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'Certipostal did not return tracking JSON');
  }
  const expected = guideId(number);
  if (httpStatus === 404 && expected && isRecord(reply) && guideId(clean(reply.message).match(/^No existe la guia (\d+)$/)?.[1]) === expected) {
    throw new NotFoundError(provider);
  }
  if (httpStatus !== 200 || !isRecord(reply) || reply.success !== true || !isRecord(reply.data) || !Array.isArray(reply.data_track)) {
    throw new SchemaError(provider, 'Certipostal omitted the guide or its movement history');
  }
  if (!expected || guideId(reply.data.tagid) !== expected) {
    throw new IndeterminateError(provider, 'Certipostal returned a different guide');
  }

  const events = new Map<string, CarrierEvent & { stage?: Stage }>();
  for (const row of reply.data_track as unknown[]) {
    if (!isRecord(row)) throw new SchemaError(provider, 'Certipostal returned an invalid movement');
    if (guideId(row.tagid) !== expected) {
      throw new IndeterminateError(provider, 'Certipostal returned a movement for a different guide');
    }
    const description = clean(row.type_state_name);
    const code = description.toUpperCase();
    if (administrativeScans.has(code) || hasPrivateDeliveryDetails(description)) continue;
    const time = DateTime.fromFormat(clean(row.dete_time), 'yyyy-MM-dd HH:mm:ss', { zone: 'utc' });
    if (!description || !time.isValid) throw new SchemaError(provider, 'Certipostal returned an invalid movement description or time');
    const localTime = time.toFormat("yyyy-MM-dd'T'HH:mm:ss");
    const city = clean(row.city_name);
    const location = hasPrivateDeliveryDetails(city) ? '' : city;
    const stage = scanStages.get(code);
    events.set(JSON.stringify([localTime, code, location]), {
      local_time: localTime, description,
      ...(location && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    });
  }

  const history = [...events.values()].sort((a, b) => (b.local_time ?? '').localeCompare(a.local_time ?? ''));
  const latest = history[0];
  if (!latest) throw new IndeterminateError(provider, 'Certipostal listed the guide without dated movements', { reason: 'listed' });
  const stage = latest.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events: history,
  };
}
