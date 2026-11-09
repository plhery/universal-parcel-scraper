import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** Dispatch labels describe movements; TYPE and CN_TRANSIT_STATUS are not status maps. */
export function omStage(wording: string): Stage | undefined {
  if (/^DELIVERED ON-\d{2}-[A-Z]{3}-\d{4}$/i.test(wording)) return 'delivered';
  if (/^OUT FOR DELIVERY$/i.test(wording)) return 'out_for_delivery';
  if (/^BOOKED FROM-./i.test(wording)) return 'accepted';
  if (/^(?:Out Date|Arrival Entry): .+ → .+$/.test(wording)) return 'in_transit';
  return undefined;
}

export const statusMap: CarrierStatusMap = { stage: (code, wording) => code ? undefined : omStage(wording), gaps: [] };
