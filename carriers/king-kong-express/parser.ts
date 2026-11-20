import { DateTime } from 'luxon';
import { ChallengeError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { stageForWording } from './status.js';

export const provider = 'king-kong-express';

interface Reply {
  status?: unknown;
  msg?: unknown;
  data?: { data?: unknown; message?: unknown; status?: unknown; transferBills?: unknown };
}

export function parseTracking(body: string): CarrierResult {
  let reply: Reply;
  try {
    reply = JSON.parse(body) as Reply;
  } catch (cause) {
    if (/cf-chl-|<title>\s*(?:Just a moment|Access Denied)/i.test(body)) {
      throw new ChallengeError(provider, 'King Kong Express requires verification', { cause });
    }
    throw new SchemaError(provider, 'King Kong Express returned invalid JSON', { cause });
  }
  const data = reply?.data;
  if (reply?.status !== 1 || reply.msg !== 'ok' || !data || !Array.isArray(data.transferBills)) {
    throw new SchemaError(provider, 'Unexpected King Kong Express tracking reply');
  }
  if (Object.keys(data).length === 1 && !data.transferBills.length) throw new NotFoundError(provider);
  if (data.status !== '1' || data.message !== 'ok' || !Array.isArray(data.data) || !data.data.length) {
    throw new SchemaError(provider, 'Missing King Kong Express waybill history');
  }
  const events: CarrierEvent[] = data.data.map((row: { context?: unknown; time?: unknown } | null) => {
    if (typeof row?.context !== 'string' || typeof row.time !== 'string') {
      throw new SchemaError(provider, 'Invalid King Kong Express scan');
    }
    const local_time = row.time.replace(' ', 'T');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(local_time) || !DateTime.fromISO(local_time, { zone: 'utc' }).isValid) {
      throw new SchemaError(provider, 'Invalid King Kong Express scan clock');
    }
    // Telephone and courier contact blocks follow movement text.
    const description = row.context.split(/【(?:电话|電話|派件员|派件員)[：:]|[，,]签收人[：:]|[，,]簽收人[：:]/, 1)[0]!.trim();
    if (!description) throw new SchemaError(provider, 'Missing King Kong Express scan wording');
    const location = /【([^】]{1,60})】/.exec(description)?.[1];
    const stage = stageForWording(normalizeStatusWording(description));
    return { description, local_time, ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  }).sort((a, b) => b.local_time.localeCompare(a.local_time));
  const newest = events[0]!;
  const stage = events.map(row => stageForWording(normalizeStatusWording(row.description!))).find(Boolean);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update_local: newest.local_time, events,
  };
}
