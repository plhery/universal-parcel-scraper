import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { scanStage } from './status.js';

export const provider = 'hede-shipping';

export function parseTracking(body: string, container: string): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'Hede requires verification');
  }
  const $ = load(body);
  let reply: unknown;
  try {
    reply = JSON.parse($('#ct-data').text());
  } catch {
    throw new SchemaError(provider, 'Hede did not return tracking data');
  }
  if (!isRecord(reply) || reply.queried !== true || typeof reply.cntr !== 'string'
      || !Array.isArray(reply.rows) || !isRecord(reply.dyn)) {
    throw new SchemaError(provider, 'Hede did not return a container-search result');
  }
  if (reply.cntr !== container) throw new IndeterminateError(provider, 'Hede answered for a different container');
  if (reply.rows.length === 0 && Object.keys(reply.dyn).length === 0) throw new NotFoundError(provider);
  const inResults = reply.rows.some(row => isRecord(row) && Array.isArray(row.cntrs)
    && row.cntrs.some(item => isRecord(item) && item.cntr === container));
  if (!inResults) throw new IndeterminateError(provider, 'Hede did not list the requested container');
  const movements = reply.dyn[container];
  if (!Array.isArray(movements)) throw new SchemaError(provider, 'Hede omitted the container movement log');

  const events = movements.map(row => {
    if (!isRecord(row) || typeof row.name !== 'string' || !row.name.trim()
        || typeof row.code !== 'string' || !row.code.trim() || typeof row.time !== 'string'
        || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(row.time)
        || !DateTime.fromSQL(row.time, { zone: 'utc' }).isValid) {
      throw new SchemaError(provider, 'Hede returned a malformed movement');
    }
    const code = row.code.trim();
    const location = typeof row.port === 'string' ? row.port.trim() : '';
    const stage = scanStage(code, row.ef);
    return {
      local_time: row.time.replace(' ', 'T') + (row.time.length === 16 ? ':00' : ''),
      description: row.name.trim(),
      provider_code: code,
      ...(location && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  }).sort((left, right) => right.local_time.localeCompare(left.local_time));

  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Hede listed the container without dated movements', { reason: 'listed' });
  return {
    status: latest.stage ? languageStageStatus(latest.stage) : 'unknown',
    ...(latest.stage && { current_stage: latest.stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description,
    last_update_local: latest.local_time,
    provider_code: latest.provider_code,
    events,
  };
}
