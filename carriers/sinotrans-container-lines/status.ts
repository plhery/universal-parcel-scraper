import type { Stage } from '../../core/status/index.js';

const loadedMovements = new Set(['MOVE IN*', 'MOVE OUT*', 'ONLOAD*', 'DISCHARGE*']);

export function scanStage(description: string, loadState: string): Stage | undefined {
  return loadState.toUpperCase() === 'FULL' && loadedMovements.has(description.toUpperCase()) ? 'in_transit' : undefined;
}
