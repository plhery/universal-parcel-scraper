import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

export function znlogicStage(_code: string | null, wording: string): Stage | undefined {
  const text = normalizeStatusWording(wording);
  if (/^delivered[.!]?$/.test(text) || /^delivered, in\/at mailbox[.!]?$/.test(text)) return 'delivered';
  if (text === 'out for delivery') return 'out_for_delivery';
  if (['arrived at post office', 'departed usps facility', 'usps in possession of item',
    'picked up by shipping partner, usps awaiting item'].includes(text)) return 'in_transit';
  if (['shipping label created', 'usps awaiting item'].includes(text)) return 'registered';
  return undefined;
}

export const statusMap: CarrierStatusMap = { stage: znlogicStage, gaps: [] };
