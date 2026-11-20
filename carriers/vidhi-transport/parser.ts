import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { shipmentStatus } from './status.js';

export const provider = 'vidhi-transport';

export function parseTracking(body: string, number: string): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'Vidhi requires verification');
  }
  const text = body.trim();
  if (!text) throw new NotFoundError(provider);
  let reply: unknown;
  try {
    reply = JSON.parse(text);
    if (isRecord(reply) && 'd' in reply) {
      reply = typeof reply.d === 'string' ? JSON.parse(reply.d) : reply.d;
    }
  } catch {
    throw new SchemaError(provider, 'Vidhi did not return a tracking record');
  }
  if (reply === null) throw new NotFoundError(provider);
  if (!isRecord(reply)) throw new SchemaError(provider, 'Vidhi returned an invalid tracking record');
  const receipt = reply.lrno;
  if (typeof receipt !== 'string' && typeof receipt !== 'number') {
    throw new SchemaError(provider, 'Vidhi omitted the lorry receipt number');
  }
  if (String(receipt) !== number) throw new IndeterminateError(provider, 'Vidhi returned a different lorry receipt');

  const rawStatus = reply.consignmentstatus ?? reply.consignmentStatus ?? reply.status;
  const code = typeof rawStatus === 'string' || typeof rawStatus === 'number' ? String(rawStatus).trim() : '';
  if (!/^\d+$/.test(code)) throw new IndeterminateError(provider, 'Vidhi listed the receipt without a status', { reason: 'listed' });
  const status = shipmentStatus(code);
  const clock = reply.statusUpdated;
  if (clock !== null && clock !== undefined && clock !== ''
      && (typeof clock !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(clock)
      || !DateTime.fromISO(clock, { zone: 'utc' }).isValid)) {
    throw new SchemaError(provider, 'Vidhi returned an invalid status clock');
  }

  return {
    status: status ? languageStageStatus(status.stage) : 'unknown',
    ...(status && { current_stage: status.stage, current_stage_source: 'carrier_map' }),
    last_status_text: status?.description ?? `Status code ${code}`,
    provider_code: code,
    ...(typeof clock === 'string' && clock && { last_update_local: clock }),
    summary_only: true,
    events: [],
  };
}
