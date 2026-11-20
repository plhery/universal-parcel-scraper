import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { isRecord } from '../../core/types.js';
import { scanDescription, scanStage } from './status.js';

export const provider = 'ellerman-city-liners';

export function parseTracking(body: string, container: string): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'The Ellerman tracking widget requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch {
    throw new SchemaError(provider, 'The Ellerman tracking widget did not return JSON');
  }
  if (!isRecord(reply) || !Array.isArray(reply.eventLogs)) throw new SchemaError(provider, 'Ellerman omitted its movement log');
  const rows: unknown[] = reply.eventLogs;
  if (rows.length === 0) {
    if (reply.vesselSchedule === null) throw new NotFoundError(provider);
    throw new IndeterminateError(provider, 'Ellerman listed a schedule without actual movements', { reason: 'listed' });
  }

  const events = rows.map(row => {
    if (!isRecord(row)) throw new SchemaError(provider, 'Ellerman returned an invalid movement');
    if (row.container_num !== container) throw new IndeterminateError(provider, 'Ellerman answered for a different container');

    const { status_code: code, event_date: clock, locname, terminal_name: terminal } = row;
    if (typeof code !== 'string' || !code.trim() || typeof clock !== 'string'
        || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(clock)
        || !DateTime.fromSQL(clock, { zone: 'utc' }).isValid) {
      throw new SchemaError(provider, 'Ellerman returned an invalid movement code or time');
    }
    const location = (typeof locname === 'string' ? locname.trim() : '')
      || (code !== 'VESS' && typeof terminal === 'string' ? terminal.trim() : '');
    const stage = scanStage(code);
    return {
      local_time: clock.replace(' ', 'T'), description: scanDescription(code), provider_code: code,
      ...(location && { location }), ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  }).reverse().sort((left, right) => right.local_time.localeCompare(left.local_time));
  const latest = events[0]!;
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ?? 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
