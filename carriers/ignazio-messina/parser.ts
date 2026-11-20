import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { scanStage } from './status.js';

export const provider = 'ignazio-messina';

export function parseTracking(body: string): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'Messina requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'Messina did not return tracking JSON');
  }
  if (!isRecord(reply)) throw new SchemaError(provider, 'Messina returned an invalid tracking reply');
  if (reply.bool_error === 'X') {
    if (typeof reply.error === 'string' && /^WRONG CHECK DIGIT\./i.test(reply.error)) {
      throw new InvalidInputError(provider, 'Messina rejected the container check digit');
    }
    throw new IndeterminateError(provider, 'Messina did not confirm the container');
  }
  if (typeof reply.TIPO !== 'string' || typeof reply.ISO !== 'string'
      || !Array.isArray(reply.CNTR) || !Array.isArray(reply.BL) || !Array.isArray(reply.MOV)) {
    throw new SchemaError(provider, 'Messina did not return equipment movements');
  }
  if (reply.CNTR.length || reply.BL.length) {
    throw new IndeterminateError(provider, 'Messina returned a list of shipments instead of equipment movements');
  }

  const events = reply.MOV.flatMap(row => {
    if (!isRecord(row) || typeof row.DESCMOV !== 'string' || !row.DESCMOV.trim()
        || typeof row.CODMOV !== 'string' || !row.CODMOV.trim()) {
      throw new SchemaError(provider, 'Messina returned an invalid movement');
    }
    const description = row.DESCMOV.trim();
    if (/^Intended\b/i.test(description)) return [];
    const date = typeof row.DATAMOV === 'string' ? DateTime.fromFormat(row.DATAMOV.trim(), 'dd/MM/yy', { zone: 'utc' }) : null;
    if (!date?.isValid) throw new SchemaError(provider, 'Messina returned an invalid actual movement date');
    const location = typeof row.LOCATION === 'string' ? row.LOCATION.trim() : '';
    const stage = scanStage(row.CODMOV, description);
    return [{
      local_time: date.toISODate(), description, provider_code: row.CODMOV,
      ...(location && { location }), ...(stage && { stage, stage_source: 'carrier_map' }),
    }];
  }).sort((left, right) => right.local_time.localeCompare(left.local_time));

  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Messina listed no actual movement', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
