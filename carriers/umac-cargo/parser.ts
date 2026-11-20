import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { milestones } from './status.js';

export const provider = 'umac-cargo';

export function parseTracking(body: string, number: string): CarrierResult {
  if (/<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource|verify (?:that )?you are human/i.test(body)) {
    throw new ChallengeError(provider, 'UMAC requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'UMAC did not return box tracking JSON');
  }
  if (!isRecord(reply) || typeof reply.found !== 'boolean' || typeof reply.trackingNo !== 'string') {
    throw new SchemaError(provider, 'UMAC omitted its box lookup outcome');
  }
  if (reply.trackingNo.toUpperCase() !== number) throw new IndeterminateError(provider, 'UMAC returned a different box');
  if (!reply.found) throw new NotFoundError(provider);
  if (!Array.isArray(reply.events)) throw new SchemaError(provider, 'UMAC omitted its movement array');

  const seen = new Set<string>();
  const events = reply.events.flatMap((row: unknown) => {
    if (!isRecord(row) || typeof row.isETA !== 'boolean' || typeof row.field !== 'string') {
      throw new SchemaError(provider, 'UMAC returned an invalid movement');
    }
    const milestone = milestones.get(row.field);
    if (row.isETA || !milestone) return [];
    const timestamp = typeof row.timestamp === 'string' ? DateTime.fromISO(row.timestamp, { setZone: true }) : null;
    if (!timestamp?.isValid) throw new SchemaError(provider, 'UMAC returned an invalid movement date');
    // The carrier displays calendar dates without clocks.
    const date = timestamp.toISODate();
    const key = JSON.stringify([row.field, date]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      local_time: date, description: milestone.label, provider_code: row.field,
      stage: milestone.stage, stage_source: 'carrier_map',
    }];
  }).sort((first, second) => second.local_time.localeCompare(first.local_time));

  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'UMAC listed the box without dated movements', { reason: 'listed' });
  const summary = reply.currentStatus;
  const current = isRecord(summary) && summary.isETA === false
    ? events.find(event => event.provider_code === summary.field && event.local_time === latest.local_time)
    : undefined;
  const state = current ?? latest;
  return {
    status: languageStageStatus(state.stage), current_stage: state.stage, current_stage_source: 'carrier_map',
    last_status_text: state.description, last_update_local: state.local_time, events,
  };
}
