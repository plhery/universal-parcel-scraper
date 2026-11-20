import type { Stage } from '../../core/status/index.js';

const stages = new Map<string, Stage>([
  ['revision', 'registered'],
  ['entregado', 'delivered'],
]);

export function scanStage(status: string): Stage | undefined {
  return stages.get(status.toLowerCase());
}
