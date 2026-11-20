import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { isRecord } from '../../core/types.js';
import { portMilestones, scanStage } from './status.js';

export const provider = 'g2-ocean';

export function parseTracking(body: string, bill: string, httpStatus: number): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'G2 Ocean requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch {
    throw new SchemaError(provider, 'G2 Ocean did not return the bill tracking JSON');
  }
  const noBill = 'The selected bol name is invalid.';
  if (httpStatus === 422 && isRecord(reply) && reply.message === noBill && isRecord(reply.errors)
      && Array.isArray(reply.errors.bol_name) && reply.errors.bol_name.length === 1 && reply.errors.bol_name[0] === noBill) {
    throw new NotFoundError(provider);
  }
  if (httpStatus !== 200 || !isRecord(reply) || !isRecord(reply.data)
      || !isRecord(reply.data.bolInformation) || !Array.isArray(reply.data.portsAndDates)) {
    throw new SchemaError(provider, 'G2 Ocean omitted the bill port calls');
  }
  if (reply.data.bolInformation.bolName !== bill) throw new IndeterminateError(provider, 'G2 Ocean answered for a different bill');
  const ports: unknown[] = reply.data.portsAndDates;
  const events = ports.flatMap(row => {
    if (!isRecord(row)) throw new SchemaError(provider, 'G2 Ocean returned an invalid port call');
    const { type, name } = row;
    if (type !== 'L' && type !== 'D') return [];
    if (typeof name !== 'string' || !name.trim()) throw new SchemaError(provider, 'G2 Ocean omitted a port name');

    return portMilestones.flatMap(({ field, wording }) => {
      const milestone = row[field];
      if (type === 'D' && field === 'departureDate') return [];
      if (!isRecord(milestone) || milestone.happened !== true) return [];
      const date = typeof milestone.date === 'string'
        && DateTime.fromFormat(milestone.date, 'd MMM yyyy, HH:mm', { locale: 'en', zone: 'utc' });
      if (!date || !date.isValid) throw new SchemaError(provider, 'G2 Ocean returned an invalid actual port time');
      const stage = scanStage(type, field);
      return [{
        local_time: date.toFormat("yyyy-MM-dd'T'HH:mm"), description: wording, location: name.trim(),
        ...(stage && { stage, stage_source: 'carrier_map' }),
      }];
    });
  }).sort((left, right) => right.local_time.localeCompare(left.local_time));
  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'G2 Ocean listed the bill without actual port calls', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ?? 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
