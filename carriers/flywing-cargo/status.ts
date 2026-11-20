import type { Stage } from '../../core/status/index.js';

const stages = new Map<string, Stage>([
  ['BOOKING', 'registered'],
  ['IN TRANSIT', 'in_transit'],
  ['AT HUB', 'in_transit'],
  ['DELIVERED', 'delivered'],
]);

export function scanStage(code: string): Stage | undefined {
  return stages.get(code.toUpperCase());
}
