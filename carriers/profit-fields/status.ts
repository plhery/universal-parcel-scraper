import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const TRANSIT = new Set(['IN_TRANSIT_TRANSFER', 'STARTED_DELIVERY', 'DELIVERED_TO_CARRIER', 'CLEARED',
  'ARRIVED_PORT', 'IN_TRANSIT', 'DELIVERED_TO_PORT']);

export function profitFieldsStage(code: string | null, wording: string): Stage | undefined {
  if (code === 'SIGNED') return 'delivered';
  if (code === 'LAST_MILE_DELIVERY') return normalizeStatusWording(wording) === 'out for delivery' ? 'out_for_delivery' : 'in_transit';
  if (code && TRANSIT.has(code)) return 'in_transit';
  if (code) return undefined;
  const text = normalizeStatusWording(wording);
  if (['shipment info confirmed', 'shipping label created'].includes(text)) return 'registered';
  if (text === 'departed facility in china') return 'in_transit';
  return undefined;
}

export const statusMap: CarrierStatusMap = { stage: (code, wording) => profitFieldsStage(code, wording), gaps: [] };
