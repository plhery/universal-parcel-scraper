import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { scanStage, summaryStage } from './status.js';

export const provider = 'sai-baba-transport';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseTracking(raw: string, number: string): CarrierResult {
  if (/<title>\s*(?:Access Denied|Just a moment|Security Check)|cf-chl|_Incapsula_Resource/i.test(raw)) {
    throw new ChallengeError(provider, 'Sai Baba Transport requires verification');
  }
  let reply: unknown;
  try { reply = JSON.parse(raw); } catch { throw new SchemaError(provider, 'Sai Baba Transport did not return tracking JSON'); }
  if (!isRecord(reply) || reply.ok !== true || !isRecord(reply.data) || reply.data.OpStatus !== 'SUCCEED'
      || typeof reply.data.LRNumber !== 'string') {
    throw new SchemaError(provider, 'Sai Baba Transport returned a malformed receipt result');
  }
  const data = reply.data;
  const rows = data.TrackData;
  if (!Array.isArray(rows)) throw new SchemaError(provider, 'Sai Baba Transport omitted the movement history');
  if (data.LRNumber !== number) throw new IndeterminateError(provider, 'Sai Baba Transport answered for a different receipt');
  if (!text(data.CurStatus) && !text(data.LRDate) && rows.length === 0) throw new NotFoundError(provider);
  const events = rows.map((row: unknown) => {
    if (!isRecord(row) || typeof row.OpDate !== 'string' || !/^\d{2}\/\d{2}\/\d{4}$/.test(row.OpDate) || !text(row.OpType)) {
      throw new SchemaError(provider, 'Sai Baba Transport returned a malformed tracking movement');
    }
    const time = DateTime.fromFormat(row.OpDate, 'dd/MM/yyyy', { zone: 'utc' }).toISODate();
    if (!time) throw new SchemaError(provider, 'Sai Baba Transport returned an invalid movement date');
    const code = text(row.OpType).toUpperCase();
    const wording = text(row.Description).replace(/\s*\[Expected Delivery On [^\]]+\]\s*$/i, '');
    const description = wording && !hasPrivateDeliveryDetails(wording) ? wording : code;
    const stage = scanStage(code);
    const location = text(code === 'IN' ? row.ToBranch : row.FromBranch);
    return {
      local_time: time, description, provider_code: code,
      ...(location && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  }).sort((left, right) => right.local_time.localeCompare(left.local_time));

  const summary = text(data.CurStatus);
  const latest = events[0];
  if (!summary && !latest) throw new IndeterminateError(provider, 'Sai Baba Transport listed the receipt without a status', { reason: 'listed' });
  const safeSummary = summary && !hasPrivateDeliveryDetails(summary) ? summary : latest?.description ?? '';
  const reportedStage = summaryStage(summary);
  const stage = reportedStage ?? latest?.stage;
  const current = reportedStage ? events.find(event => event.stage === reportedStage) : latest;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: safeSummary,
    ...(current && { last_update_local: current.local_time, provider_code: current.provider_code }),
    events,
  };
}
