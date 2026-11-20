import type { Stage } from '../../core/status/index.js';

const loadedMovements = new Map<string, Stage>([
  ['RBS', 'accepted'],
  ['LOB', 'in_transit'],
  ['DIS', 'in_transit'],
  ['DTC', 'in_transit'],
]);

export function scanStage(code: string, loadState: unknown): Stage | undefined {
  return loadState === 'F' ? loadedMovements.get(code) : undefined;
}
