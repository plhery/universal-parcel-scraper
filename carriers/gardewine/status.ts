import type { Stage } from '../../core/status/index.js';

const stages = new Map<string, Stage>([
  ['DELIVERED; THANK YOU FOR USING GARDEWINE', 'delivered'],
  ['Out For Delivery', 'out_for_delivery'],
  ['Trailer Arrived', 'in_transit'],
  ['Picked Up', 'accepted'],
  ['Pickup Request Received', 'registered'],
]);

export function scanStage(description: string): Stage | undefined {
  if (/^Trailer Departed For \S/i.test(description)) return 'in_transit';
  return stages.get(description);
}
