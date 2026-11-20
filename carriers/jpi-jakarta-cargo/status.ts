import type { Stage } from '../../core/status/index.js';

const stages = new Map<string, Stage>([
  ['RECEIVED JPI', 'accepted'],
  ['ON SHIPPING', 'in_transit'],
  ['ON SHIPPING TO BRANCH', 'in_transit'],
  ['UNLOADING OFFICE HQ', 'in_transit'],
  ['UNLOADING OFFICE BRANCH', 'in_transit'],
  ['DELIVERED', 'delivered'],
]);

export function scanStage(status: string): Stage | undefined {
  return stages.get(status);
}
