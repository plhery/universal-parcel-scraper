import type { Stage } from '../../core/status/index.js';

const stages = new Map<string, Stage>([
  ['Booked', 'registered'],
  ['Received From Shipper', 'accepted'],
  ['Departed on Flight', 'in_transit'],
  ['Received From Flight', 'in_transit'],
  ['Consignee/Agent notified of arrival', 'in_transit'],
  ['Delivered', 'delivered'],
]);

export function scanStage(description: string): Stage | undefined {
  return stages.get(description);
}
