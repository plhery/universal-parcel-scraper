import { DateTime } from 'luxon';
import { ChallengeError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { stageForCode } from './status.js';

export const provider = 'herona-express';
export const isChallenge = (body: string): boolean => /cf-chl-|<title>\s*(?:Just a moment|Access Denied)/i.test(body);

interface Reply {
  data?: { asal?: unknown; tujuan?: unknown } | null;
  history?: unknown;
}

export function parseTracking(body: string): CarrierResult {
  let reply: Reply;
  try {
    reply = JSON.parse(body) as Reply;
  } catch (cause) {
    if (isChallenge(body)) throw new ChallengeError(provider, 'Herona Express requires verification', { cause });
    throw new SchemaError(provider, 'Herona Express returned invalid JSON', { cause });
  }
  if (!Array.isArray(reply?.history)) throw new SchemaError(provider, 'Missing Herona Express history');
  if (reply.data === null && !reply.history.length) throw new NotFoundError(provider);
  if (typeof reply.data?.asal !== 'string' || typeof reply.data.tujuan !== 'string') {
    throw new SchemaError(provider, 'Invalid Herona Express shipment summary');
  }
  const scans = reply.history.map((row: { id?: unknown; status?: unknown; date_created?: unknown } | null) => {
    if (typeof row?.id !== 'string' || typeof row.status !== 'string' || !row.status.trim() || typeof row.date_created !== 'string') {
      throw new SchemaError(provider, 'Invalid Herona Express history row');
    }
    const clock = DateTime.fromFormat(row.date_created, 'd MMM yyyy, HH:mm:ss', { zone: 'utc', locale: 'en' });
    if (!clock.isValid) throw new SchemaError(provider, 'Invalid Herona Express scan clock');
    const stage = stageForCode(row.id);
    const event: CarrierEvent = {
      description: row.status.trim(), provider_code: row.id, local_time: clock.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
    return { clock, event, stage };
  }).sort((a, b) => b.clock.toMillis() - a.clock.toMillis());
  const latest = scans[0]?.event;
  if (!latest) throw new NoHistoryError(provider);
  const stage = scans.find(scan => scan.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description, last_update_local: latest.local_time, events: scans.map(scan => scan.event),
  };
}
