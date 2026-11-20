import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { isRecord } from '../../core/types.js';
import { scanMeaning } from './status.js';

export const provider = 'sea-legend-line';

export function parseTracking(body: string, number: string): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'Sea Legend requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'Sea Legend did not return tracking JSON');
  }
  if (!isRecord(reply) || reply.success !== true || reply.code !== 200
      || !isRecord(reply.result) || !Array.isArray(reply.result.containerList)) {
    throw new SchemaError(provider, 'Sea Legend did not return a successful cargo search');
  }
  const containers = reply.result.containerList;
  if (containers.length === 0) throw new NotFoundError(provider);
  const matches = containers.filter(row => isRecord(row) && row.ctnno === number);
  if (matches.length !== 1) throw new IndeterminateError(provider, 'Sea Legend did not identify one exact container');
  const container: unknown = matches[0];
  if (!isRecord(container) || !Array.isArray(container.nodeList)) {
    throw new SchemaError(provider, 'Sea Legend omitted the container movement list');
  }

  const seen = new Set<string>();
  const events = container.nodeList.flatMap(row => {
    if (!isRecord(row)) throw new SchemaError(provider, 'Sea Legend returned an invalid movement');
    const date = row.actualDate;
    if (date === null || date === undefined || date === '') return [];
    const code = row.movementCode;
    if (typeof code !== 'string' || !code.trim() || typeof date !== 'string'
        || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(date)
        || !DateTime.fromSQL(date, { zone: 'utc' }).isValid) {
      throw new SchemaError(provider, 'Sea Legend returned an invalid actual movement');
    }
    const port = typeof row.eventPort === 'string' ? row.eventPort.trim() : '';
    const portName = typeof row.portName === 'string' ? row.portName.trim() : '';
    const key = JSON.stringify([date, code, port || portName]);
    if (seen.has(key)) return [];
    seen.add(key);

    const location = portName || port;
    const movement = scanMeaning(code);
    const rawName = typeof row.movementName === 'string' ? row.movementName.trim() : '';
    const description = movement?.description ?? (rawName || code);
    return [{
      local_time: / 00:00(?::00)?$/.test(date) ? date.slice(0, 10) : date.replace(' ', 'T'), description, provider_code: code,
      ...(location && { location }),
      ...(movement?.stage && { stage: movement.stage, stage_source: 'carrier_map' }),
    }];
  }).sort((left, right) => right.local_time.localeCompare(left.local_time));

  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Sea Legend listed the container without actual movements', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ?? 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
