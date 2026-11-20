import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { scanMeaning } from './status.js';

export const provider = 'kenya-airways-cargo';

export function parseTracking(body: string, awb: string): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'Kenya Airways Cargo requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'Kenya Airways Cargo did not return tracking JSON');
  }

  if (!isRecord(reply) || !Array.isArray(reply.trackingDatas) || !Array.isArray(reply.trackingMilestones)
      || !Array.isArray(reply.trackingOffloadDatas)) {
    throw new SchemaError(provider, 'Kenya Airways Cargo omitted its tracking lists');
  }
  const { trackingDatas, trackingMilestones, trackingOffloadDatas } = reply;
  if (!trackingDatas.length && !trackingMilestones.length && !trackingOffloadDatas.length) throw new NotFoundError(provider);
  const serial = awb.slice(4);
  if (!trackingDatas.length || !trackingDatas.every(row => isRecord(row) && row.trackAWBNo === awb && row.awbNo === serial)) {
    throw new IndeterminateError(provider, 'Kenya Airways Cargo did not confirm the full air waybill');
  }

  const events = trackingMilestones.map(row => {
    if (!isRecord(row)) throw new SchemaError(provider, 'Kenya Airways Cargo returned an invalid milestone');
    if (row.awbNo !== serial) throw new IndeterminateError(provider, 'Kenya Airways Cargo returned a different milestone serial');
    const code = typeof row.action === 'string' ? row.action.trim() : '';
    const date = typeof row.createdon === 'string'
      ? DateTime.fromFormat(row.createdon.trim(), 'dd-MMM-yyyy HH:mm', { zone: 'utc', locale: 'en' })
      : null;
    if (!code || !date?.isValid) throw new SchemaError(provider, 'Kenya Airways Cargo returned an invalid milestone code or time');
    const location = typeof row.station === 'string' ? row.station.trim() : '';
    const meaning = scanMeaning(code);
    const description = meaning?.showsStation && location ? `${meaning.label} ${location}` : meaning?.label ?? code;
    return {
      local_time: date.toFormat("yyyy-MM-dd'T'HH:mm"),
      description,
      provider_code: code,
      ...(location && { location }),
      ...(meaning?.stage && { stage: meaning.stage, stage_source: 'carrier_map' }),
    };
  }).reverse().sort((left, right) => right.local_time.localeCompare(left.local_time));

  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Kenya Airways Cargo listed the air waybill without dated milestones', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
