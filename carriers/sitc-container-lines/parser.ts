import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { isRecord } from '../../core/types.js';
import { scanStage } from './status.js';

export const provider = 'sitc-container-lines';

export function parseTracking(body: string, container: string): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'SITC requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch {
    throw new SchemaError(provider, 'SITC did not return tracking JSON');
  }
  if (!isRecord(reply) || reply.success !== true || !isRecord(reply.data) || !Array.isArray(reply.data.list)) {
    throw new SchemaError(provider, 'SITC did not return a successful movement search');
  }
  const rows: unknown[] = reply.data.list;
  if (rows.length === 0) throw new NotFoundError(provider);
  const events = rows.map(row => {
    if (!isRecord(row)) throw new SchemaError(provider, 'SITC returned an invalid container movement');
    if (row.containerNo !== container) throw new IndeterminateError(provider, 'SITC answered for a different container');
    const { movementCode, eventDate, eventPort } = row;
    if (typeof movementCode !== 'string' || !movementCode.trim() || typeof eventDate !== 'string'
        || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(eventDate)
        || !DateTime.fromSQL(eventDate, { zone: 'utc' }).isValid) {
      throw new SchemaError(provider, 'SITC returned an invalid movement date or description');
    }
    const description = movementCode.trim();
    const location = typeof eventPort === 'string' ? eventPort.trim() : '';
    const stage = scanStage(description);
    return {
      local_time: eventDate.replace(' ', 'T'), description, provider_code: description,
      ...(location && { location }), ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  }).sort((left, right) => right.local_time.localeCompare(left.local_time));
  const latest = events[0]!;
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ?? 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
