import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { isRecord } from '../../core/types.js';
import { scanStage } from './status.js';

export const provider = 'tanto-intim-line';

export function parseTracking(body: string, number: string): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'Tanto requires verification');
  }

  let reply: unknown;
  try {
    reply = JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch {
    throw new SchemaError(provider, 'Tanto did not return tracking JSON');
  }
  if (!isRecord(reply)) throw new SchemaError(provider, 'Tanto changed its tracking reply');
  if (reply.status === false && reply.msg === 'No data found') throw new NotFoundError(provider);
  if (reply.status !== true || !isRecord(reply.data) || typeof reply.data.container !== 'string') {
    throw new SchemaError(provider, 'Tanto did not return a successful container search');
  }

  if (reply.data.container.replace(/[\s-]+/g, '').toUpperCase() !== number) {
    throw new IndeterminateError(provider, 'Tanto answered for a different container');
  }
  const { activity, act_date: clock } = reply.data;
  const day = typeof clock === 'string' && /^\d{2} [A-Za-z]{3} \d{4}$/.test(clock.trim())
    ? DateTime.fromFormat(clock.trim(), 'dd MMM yyyy', { locale: 'en', zone: 'utc' }).toISODate() : null;
  if (typeof activity !== 'string' || !activity.trim() || !day) {
    throw new SchemaError(provider, 'Tanto returned an invalid container activity');
  }
  const description = activity.trim();
  const stage = scanStage(description);
  return {
    status: stage ?? 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: description,
    last_update_local: day,
    events: [{ local_time: day, description, ...(stage && { stage, stage_source: 'carrier_map' }) }],
  };
}
