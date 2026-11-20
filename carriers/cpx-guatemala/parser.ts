import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { orderComparableScans } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { cpxDescription, cpxStage, documentaryCodes } from './status.js';

const carrier = 'cpx-guatemala';

export function parseTracking(text: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(text.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'CPX returned a browser check');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new SchemaError(carrier, 'CPX returned invalid tracking JSON');
  }
  if (!isRecord(reply) || !Array.isArray(reply.items) || reply.items.length > 500 || typeof reply.query !== 'string') {
    throw new SchemaError(carrier, 'CPX changed its public tracking reply');
  }
  if (reply.query.trim().toUpperCase() !== number) throw new IndeterminateError(carrier, 'CPX returned a different tracking reference');
  if (!reply.items.length) throw new NotFoundError(carrier);

  const events: (CarrierEvent & { provider_code: string; description: string; stage?: Stage })[] = [];
  for (const item of reply.items as unknown[]) {
    if (!isRecord(item)) throw new SchemaError(carrier, 'CPX changed its tracking events');
    const code = clean(item.status, 60);
    const stamp = clean(item.date, 64);
    const time = explicitOffsetTime(stamp);
    const local = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/.test(stamp)
      && DateTime.fromISO(stamp, { zone: 'UTC' }).isValid;
    if (!/^[A-Z0-9_]+$/.test(code) || (!time && !local)) {
      throw new SchemaError(carrier, 'CPX changed its tracking status or clock');
    }
    const description = cpxDescription(code, clean(item.activity, 180));
    const stage = cpxStage(code, description);
    const location = clean(item.ubication, 100);
    events.push({
      description, provider_code: code, ...(time ? { time: time.iso } : { local_time: stamp }),
      ...(location && { location }), ...(stage && { stage, stage_source: 'explicit_mapping' }),
    });
  }

  const ordered = orderComparableScans(events, event => event.time ? 'instant' : 'wall');
  const latest = ordered[0]!;
  const stage = ordered.find(event => !documentaryCodes.has(event.provider_code))?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: latest.description, provider_code: latest.provider_code,
    last_update: latest.time ?? null, ...(latest.local_time && { last_update_local: latest.local_time }),
    expected_delivery: null, events: ordered.slice(0, 100), ...(ordered.length > 100 && { history_truncated: true }),
  };
}
