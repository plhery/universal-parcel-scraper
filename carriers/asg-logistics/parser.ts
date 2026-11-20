import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { movementSummary } from './status.js';

export const provider = 'asg-logistics';
export type ReferenceType = 'hawb' | 'mawb' | 'do';

function matches(value: unknown, number: string): boolean {
  return typeof value === 'string' && value.replace(/[\s-]+/g, '').toUpperCase() === number;
}

export function parseTracking(raw: string, number: string, type: ReferenceType): CarrierResult {
  if (/<title>\s*(?:Access Denied|Just a moment|Security Check)|cf-chl|_Incapsula_Resource/i.test(raw)) {
    throw new ChallengeError(provider, 'ASG Logistics requires verification');
  }
  let reply: unknown;
  try { reply = JSON.parse(raw); } catch { throw new SchemaError(provider, 'ASG Logistics did not return tracking JSON'); }
  if (!isRecord(reply) || reply.success !== true) throw new SchemaError(provider, 'ASG Logistics did not confirm the search');
  const data = reply.data;
  if (type === 'mawb' && Array.isArray(data) && data.length === 0) throw new NotFoundError(provider);
  if (!isRecord(data) || !Array.isArray(data.shipments)) throw new SchemaError(provider, 'ASG Logistics omitted shipment results');
  if (data.shipments.length === 0 && data.status_text === 'Không tìm thấy') throw new NotFoundError(provider);
  const movements = data.shipments.flatMap((shipment: unknown): unknown[] => {
    if (!isRecord(shipment) || !Array.isArray(shipment.timeline)) return [];
    if (type === 'mawb' && !matches(shipment.mawb, number)) return [];
    if (type === 'do' && !matches(shipment.shipment, number)) return [];
    if (type === 'hawb') return shipment.timeline.filter((row: unknown) => isRecord(row) && matches(row.hawb, number));
    return shipment.timeline;
  });
  const row = movements[0];
  if (!isRecord(row) || typeof row.status !== 'string') {
    throw new IndeterminateError(provider, 'ASG Logistics did not return a movement for the exact reference');
  }
  const summary = movementSummary(row.status);
  if (!summary) throw new IndeterminateError(provider, 'ASG Logistics listed the shipment without a supported status summary', { reason: 'listed' });
  return {
    status: summary.stage ? languageStageStatus(summary.stage) : 'unknown',
    ...(summary.stage && { current_stage: summary.stage, current_stage_source: 'carrier_map' }),
    last_status_text: summary.description,
    summary_only: true,
    events: [],
  };
}
