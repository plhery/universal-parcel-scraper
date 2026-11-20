import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { scanStage } from './status.js';

export const provider = 'jpi-jakarta-cargo';

export function parseTracking(body: string, number: string): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'JPI Jakarta Cargo requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'JPI Jakarta Cargo did not return tracking JSON');
  }
  if (!isRecord(reply) || reply.success !== true) throw new SchemaError(provider, 'JPI Jakarta Cargo omitted its tracking result');
  const { data } = reply;
  if (data === null) throw new NotFoundError(provider);
  if (!isRecord(data) || !Number.isSafeInteger(data.id) || !Array.isArray(data.resi_tracking)) {
    throw new SchemaError(provider, 'JPI Jakarta Cargo returned an invalid shipment or history');
  }
  if (data.no_resi !== number) throw new IndeterminateError(provider, 'JPI Jakarta Cargo did not confirm the full shipment number');
  const events = data.resi_tracking.map(row => {
    if (!isRecord(row)) throw new SchemaError(provider, 'JPI Jakarta Cargo returned an invalid scan');
    if (row.resi_id !== data.id) throw new IndeterminateError(provider, 'JPI Jakarta Cargo returned a scan from a different shipment');
    const code = clean(row.status).toUpperCase();
    const date = DateTime.fromFormat(clean(row.datetime), 'yyyy-MM-dd HH:mm:ss', { zone: 'utc' });
    if (!code || !date.isValid) throw new SchemaError(provider, 'JPI Jakarta Cargo returned an invalid status or scan time');
    const stage = scanStage(code);
    return {
      local_time: date.toFormat("yyyy-MM-dd'T'HH:mm:ss"), description: code, provider_code: code,
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  }).reverse().sort((first, second) => second.local_time.localeCompare(first.local_time));
  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'JPI Jakarta Cargo listed the shipment without dated scans', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
