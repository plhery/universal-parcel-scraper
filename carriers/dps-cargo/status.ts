import type { Stage } from '../../core/status/index.js';

const stages = new Map<string, Stage>([
  ['BERANGKAT', 'in_transit'],
  ['TRANSIT', 'in_transit'],
  ['DELIVERED', 'delivered'],
]);

export function scanStage(code: string): Stage | undefined {
  return stages.get(code);
}
