import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { scanStage } from './status.js';

export const provider = 'karya-pratama-cargo';

export function parseTracking(body: string, number: string, httpStatus: number): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'Karya Pratama Cargo requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'Karya Pratama Cargo did not return tracking JSON');
  }
  if (httpStatus === 404 && isRecord(reply) && reply.success === false && reply.message === 'Data resi tidak ditemukan') {
    throw new NotFoundError(provider);
  }
  if (httpStatus !== 200 || !isRecord(reply) || reply.success !== true || !isRecord(reply.data)
      || !isRecord(reply.data.info) || !Array.isArray(reply.data.history)) {
    throw new SchemaError(provider, 'Karya Pratama Cargo omitted its shipment or history');
  }
  const { info, history } = reply.data;
  if (info.no_resi !== number) throw new IndeterminateError(provider, 'Karya Pratama Cargo did not confirm the full shipment number');
  const events = history.map(row => {
    if (!isRecord(row)) throw new SchemaError(provider, 'Karya Pratama Cargo returned an invalid movement');
    const description = clean(row.status);
    const date = DateTime.fromFormat(clean(row.timestamp_update), 'yyyy-MM-dd HH:mm:ss', { zone: 'utc' });
    if (!description || !date.isValid) throw new SchemaError(provider, 'Karya Pratama Cargo returned an invalid status or time');
    const location = clean(row.lokasi);
    const stage = scanStage(description);
    return {
      local_time: date.toFormat("yyyy-MM-dd'T'HH:mm:ss"), description,
      ...(location && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  }).sort((first, second) => second.local_time.localeCompare(first.local_time));
  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Karya Pratama Cargo listed the shipment without dated movements', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
