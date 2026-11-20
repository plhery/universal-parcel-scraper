import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { scanStage } from './status.js';

export const provider = 'sm-line';

function readRows(body: string): { count: number; rows: unknown[] } {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'SM Line requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch {
    throw new SchemaError(provider, 'SM Line did not return tracking JSON');
  }
  if (!isRecord(reply) || reply.TRANS_RESULT_KEY !== 'S' || reply.Exception !== ''
      || typeof reply.count !== 'string' || !/^\d+$/.test(reply.count)) {
    throw new SchemaError(provider, 'SM Line did not return a successful tracking reply');
  }
  const count = Number(reply.count);
  const rows: unknown = reply.list ?? [];
  if (!Number.isSafeInteger(count) || !Array.isArray(rows) || rows.length > count || (count > 0 && rows.length === 0)) {
    throw new SchemaError(provider, 'SM Line returned inconsistent tracking rows');
  }
  return { count, rows };
}

export function parseBill(body: string, number: string): { container: string; booking: string; movementId: string } {
  const { count, rows } = readRows(body);
  if (count === 0) throw new NotFoundError(provider);
  const match = rows.find(row => isRecord(row) && row.blNo === number);
  if (!isRecord(match)) throw new IndeterminateError(provider, 'SM Line answered for a different bill of lading');
  if (count !== 1 || match.cntrFlg !== 'Y') {
    throw new IndeterminateError(provider, 'SM Line did not return a single-container bill', { reason: 'listed' });
  }
  const { cntrNo: container, dspBkgNo: booking, copNo: movementId } = match;
  if (typeof container !== 'string' || !/^[A-Z]{4}\d{7}$/.test(container)
      || typeof booking !== 'string' || !/^[A-Z0-9]{1,30}$/.test(booking)
      || typeof movementId !== 'string' || !/^[A-Z0-9]{1,30}$/.test(movementId)) {
    throw new SchemaError(provider, 'SM Line omitted the container movement identifiers');
  }
  return { container, booking, movementId };
}

export function parseMovements(body: string, movementId: string): CarrierResult {
  const { count, rows } = readRows(body);
  if (count !== rows.length) throw new SchemaError(provider, 'SM Line returned an incomplete movement history');
  const events: (CarrierEvent & { stage?: ReturnType<typeof scanStage> })[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(provider, 'SM Line returned an invalid movement');
    if (row.copNo !== movementId) throw new IndeterminateError(provider, 'SM Line answered for a different movement record');
    if (row.actTpCd === 'E') continue;
    const { statusNm, statusCd, eventDt, placeNm } = row;
    if (row.actTpCd !== 'A' || typeof statusNm !== 'string' || !statusNm.trim()
        || typeof statusCd !== 'string' || !statusCd || typeof eventDt !== 'string'
        || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(eventDt)
        || !DateTime.fromSQL(eventDt, { zone: 'utc' }).isValid) {
      throw new SchemaError(provider, 'SM Line returned an invalid actual movement');
    }
    const description = statusNm.replace(/<br\s*\/?>/gi, ' ').trim();
    const location = typeof placeNm === 'string' ? placeNm.trim().replace(/\s*,\s*/g, ', ') : '';
    const stage = scanStage(statusCd, description);
    events.push({
      local_time: eventDt.replace(' ', 'T'), description, provider_code: statusCd,
      ...(location && { location }), ...(stage && { stage, stage_source: 'carrier_map' }),
    });
  }
  // The movement table lists oldest first, including movements at the same minute.
  events.reverse().sort((left, right) => (right.local_time ?? '').localeCompare(left.local_time ?? ''));
  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'SM Line listed the container without actual movements', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
