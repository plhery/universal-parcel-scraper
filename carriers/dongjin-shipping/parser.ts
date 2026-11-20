import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { isRecord } from '../../core/types.js';
import { scanStage } from './status.js';

export const provider = 'dongjin-shipping';

function searchRows(body: string): unknown[] {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'Dongjin requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch {
    throw new SchemaError(provider, 'Dongjin did not return tracking JSON');
  }
  if (!isRecord(reply) || reply.TRANS_RESULT_KEY !== 'S' || reply.Exception !== '') {
    throw new SchemaError(provider, 'Dongjin did not return a successful cargo search');
  }
  if (reply.count === '0' && (reply.list === undefined || (Array.isArray(reply.list) && reply.list.length === 0))) return [];
  if (!Array.isArray(reply.list) || reply.list.length === 0 || String(reply.list.length) !== reply.count) {
    throw new SchemaError(provider, 'Dongjin returned mismatched cargo search rows');
  }
  return reply.list;
}

export function parseBooking(body: string): { bkgNo: string; copNo: string } {
  const rows = searchRows(body);
  if (rows.length === 0) throw new NotFoundError(provider);
  if (rows.length !== 1) throw new IndeterminateError(provider, 'Dongjin returned multiple bookings for the container');
  const row = rows[0];
  if (!isRecord(row) || typeof row.bkgNo !== 'string' || !/^[A-Z0-9-]{1,32}$/.test(row.bkgNo)
      || typeof row.copNo !== 'string' || !/^[A-Z0-9-]{1,32}$/.test(row.copNo)) {
    throw new SchemaError(provider, 'Dongjin omitted the cargo detail references');
  }
  return { bkgNo: row.bkgNo, copNo: row.copNo };
}

export function parseTracking(body: string, copNo: string): CarrierResult {
  const events = searchRows(body).flatMap(row => {
    if (!isRecord(row)) throw new SchemaError(provider, 'Dongjin returned an invalid cargo movement');
    if (row.copNo !== copNo) throw new IndeterminateError(provider, 'Dongjin answered for a different cargo detail reference');
    if (typeof row.actTpCd !== 'string' || !row.actTpCd) {
      throw new SchemaError(provider, 'Dongjin omitted the cargo movement type');
    }
    if (row.actTpCd !== 'A') return [];
    const { eventDt, statusNm, statusCd } = row;
    if (typeof statusNm !== 'string' || !statusNm.trim() || typeof statusCd !== 'string' || !statusCd.trim()
        || typeof eventDt !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(eventDt)
        || !DateTime.fromSQL(eventDt, { zone: 'utc' }).isValid) {
      throw new SchemaError(provider, 'Dongjin returned an invalid actual cargo movement');
    }
    const location = typeof row.placeNm === 'string' ? row.placeNm.trim() : '';
    const stage = scanStage(statusCd);
    return [{
      local_time: eventDt.replace(' ', 'T'), description: statusNm.trim(), provider_code: statusCd,
      ...(location && { location }), ...(stage && { stage, stage_source: 'carrier_map' }),
    }];
  }).sort((left, right) => right.local_time.localeCompare(left.local_time));
  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Dongjin listed the container without actual movements', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ?? 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
