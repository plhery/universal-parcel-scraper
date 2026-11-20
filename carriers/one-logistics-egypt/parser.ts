import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { classifyWording, hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { stages } from './status.js';

export const provider = 'one-logistics-egypt';

export function parseTracking(response: unknown, number: string): CarrierResult {
  if (!isRecord(response) || response.success !== true || !isRecord(response.data)) {
    throw new SchemaError(provider, 'ONE Logistics did not return a freight record');
  }
  const data = response.data;
  if (data.status === 'error' && data.message === 'Shipment not found') throw new NotFoundError(provider);
  if (data.status !== 'success') throw new SchemaError(provider, 'ONE Logistics returned an unrecognized freight response');
  if (typeof data.shipment_ref !== 'string' || clean(data.shipment_ref).toLowerCase() !== number.toLowerCase()) {
    throw new IndeterminateError(provider, 'ONE Logistics did not return the requested freight reference');
  }
  const wording = typeof data.current_stage === 'string' ? clean(data.current_stage) : '';
  if (!wording || hasPrivateDeliveryDetails(wording)) {
    throw new IndeterminateError(provider, 'ONE Logistics listed the freight without a public status', { reason: 'listed' });
  }
  const mapped = stages.get(wording.toLowerCase());
  const fallback = mapped === undefined ? classifyWording(wording, 'pending') : undefined;
  const stage = mapped ?? (fallback && fallback.source !== 'none' ? fallback.stage : undefined);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: fallback?.source ?? 'carrier_map' }),
    last_status_text: wording,
    summary_only: true,
  };
}
