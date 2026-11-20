import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { jomaStatus } from './status.js';

const carrier = 'joma-logistics';

export function parseTracking(text: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(text.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'JOMA returned a browser check');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new SchemaError(carrier, 'JOMA returned invalid tracking JSON');
  }
  if (!isRecord(reply)) throw new SchemaError(carrier, 'JOMA changed its tracking response');
  if (reply.result === null && Object.keys(reply).length === 1) throw new NotFoundError(carrier);
  const result = reply.result;
  if (!isRecord(result) || !Array.isArray(result.steps) || result.steps.length > 50) {
    throw new SchemaError(carrier, 'JOMA changed its departure record');
  }
  if (result.trackingNumber !== number) throw new IndeterminateError(carrier, 'JOMA returned a different departure reference');
  if (result.destination !== 'Tajikistan') throw new IndeterminateError(carrier, 'JOMA returned a departure outside the public tracker’s scope');

  const current = typeof result.current === 'string' ? jomaStatus(result.current) : undefined;
  if (!current) throw new SchemaError(carrier, 'JOMA returned an unknown departure milestone');

  const reached = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const step of result.steps as unknown[]) {
    if (!isRecord(step) || typeof step.step !== 'string' || typeof step.reached !== 'boolean') {
      throw new SchemaError(carrier, 'JOMA changed its progress steps');
    }
    if (!step.reached) continue;
    const status = jomaStatus(step.step);
    if (!status || reached.has(step.step)) throw new SchemaError(carrier, 'JOMA changed its reached milestones');
    reached.add(step.step);
    if (step.date === null) continue;
    if (typeof step.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(step.date)
      || !DateTime.fromISO(step.date, { zone: 'UTC' }).isValid) {
      throw new SchemaError(carrier, 'JOMA returned an invalid milestone date');
    }
    events.push({
      local_time: step.date, description: status.wording, provider_code: status.code,
      stage: status.stage, stage_source: 'explicit_mapping',
    });
  }
  if (!reached.has(current.code)) throw new IndeterminateError(carrier, 'JOMA returned inconsistent departure progress');
  // The page lists its steps oldest first. Reversing preserves that order on days with ties.
  events.reverse().sort((a, b) => b.local_time!.localeCompare(a.local_time!));

  return {
    status: languageStageStatus(current.stage), current_stage: current.stage, current_stage_source: 'explicit_mapping',
    last_status_text: current.wording, provider_code: current.code, last_update: null,
    ...(events[0]?.local_time && { last_update_local: events[0].local_time }),
    expected_delivery: null, events, ...(!events.length && { summary_only: true }),
  };
}
