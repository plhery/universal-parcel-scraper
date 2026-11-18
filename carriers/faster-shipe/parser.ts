import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { stageOf } from './status.js';

const provider = 'faster-shipe';

export function parseTracking(text: string, number: string, httpStatus: number): CarrierResult {
  let reply: unknown;
  try { reply = JSON.parse(text); }
  catch { throw new SchemaError(provider, 'Tracking service returned invalid JSON'); }
  if (!isRecord(reply)) throw new SchemaError(provider, 'Invalid shipment reply');
  if (httpStatus === 404 && reply.error === 'لم يُعثر على شحنة بهذا الرقم') throw new NotFoundError(provider);
  if (httpStatus !== 200 || !Array.isArray(reply.timeline)) throw new SchemaError(provider, 'Missing shipment timeline');
  if (reply.id !== number) throw new IndeterminateError(provider, 'Shipment identity mismatch');
  const current = reply.timeline.filter((step: unknown) => isRecord(step) && step.current === true);
  const step: unknown = current[0];
  if (current.length !== 1 || !isRecord(step) || step.status !== reply.status || typeof step.label !== 'string' || !step.label.trim()) {
    throw new SchemaError(provider, 'Inconsistent current milestone');
  }
  const stage = stageOf(step.label);
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: step.label, events: [], summary_only: true };

}
