import type { Stage } from '../../core/status/index.js';

const stages = new Map<string, Stage>([
  ['picked up', 'accepted'],
  ['in transit', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

export function stageForWording(wording: string): Stage | undefined {
  return stages.get(wording.toLowerCase());
}
