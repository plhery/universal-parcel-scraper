import type { Stage } from '../../core/status/index.js';

const stages = new Map<string, Stage>([
  ['RECEIVED FROM SHIPPER', 'accepted'],
  ['LOAD FULL', 'in_transit'],
  ['DISCHARGE FULL', 'in_transit'],
  ['SENT TO CONSIGNEE', 'in_transit'],
]);

export function scanStage(description: string): Stage | undefined {
  return stages.get(description.toUpperCase());
}
