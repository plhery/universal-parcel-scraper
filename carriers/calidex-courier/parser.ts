import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { scanStage } from './status.js';

export const provider = 'calidex-courier';

export function parseTracking(raw: string, number: string): CarrierResult {
  if (/<title>\s*(?:Access Denied|Just a moment|Security Check)|cf-chl|_Incapsula_Resource/i.test(raw)) {
    throw new ChallengeError(provider, 'Calidex requires verification');
  }
  let reply: unknown;
  try { reply = JSON.parse(raw); } catch { throw new SchemaError(provider, 'Calidex did not return tracking JSON'); }
  if (!Array.isArray(reply) || reply[2] !== 1) throw new SchemaError(provider, 'Calidex did not return a guide search');
  const rows: unknown = reply[0];
  const references: unknown = reply[1];
  if (!Array.isArray(rows) || !Array.isArray(references)) throw new SchemaError(provider, 'Calidex omitted the guide result');
  const reference: unknown = references[0];
  if (references.length !== 1 || !isRecord(reference) || typeof reference.number !== 'string') {
    throw new SchemaError(provider, 'Calidex omitted the guide identity');
  }
  if (reference.number === '' && rows.length === 0) throw new NotFoundError(provider);
  if (reference.number !== number) throw new IndeterminateError(provider, 'Calidex answered for a different guide');
  const events = rows.map((row: unknown) => {
    if (!isRecord(row) || typeof row.date !== 'string' || typeof row.name !== 'string' || !row.name.trim()
        || !/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/.test(row.date)) {
      throw new SchemaError(provider, 'Calidex returned a malformed movement');
    }
    const time = DateTime.fromFormat(row.date, 'MM/dd/yyyy HH:mm:ss', { zone: 'utc' }).toISO({
      includeOffset: false, suppressMilliseconds: true,
    });
    if (!time) throw new SchemaError(provider, 'Calidex returned an invalid movement date');
    const description = row.name.trim();
    const location = typeof row.place === 'string' ? row.place.trim() : '';
    const stage = scanStage(description);
    return {
      local_time: time, description,
      ...(location && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  }).sort((left, right) => right.local_time.localeCompare(left.local_time));

  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Calidex listed the guide without dated movements', { reason: 'listed' });
  return {
    status: latest.stage ? languageStageStatus(latest.stage) : 'unknown',
    ...(latest.stage && { current_stage: latest.stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description,
    last_update_local: latest.local_time,
    events,
  };
}
