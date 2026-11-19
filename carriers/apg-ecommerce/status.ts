import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';

const stages = new Map<string, Stage>([
  ['delivered', 'delivered'],
  ['out for delivery', 'out_for_delivery'],
  ['attempted delivery', 'failed_attempt'],
  ['parcel in transit back to sender', 'exception'],
  ['parcel processing at final carrier hub', 'in_transit'],
  ['in transit to local carrier', 'in_transit'],
  ['parcel to be delivered by local carrier', 'in_transit'],
  ['parcel cleared by customs', 'in_transit'],
  ['parcel processed', 'in_transit'],
]);

export function apgEcommerceStage(wording: string): Stage | undefined {
  return stages.get(normalizeStatusWording(wording));
}
