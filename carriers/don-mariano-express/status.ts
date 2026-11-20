import type { Stage } from '../../core/status/index.js';

export const confirmedMovement = '✓ Confirmado';

export const movementStages: ReadonlyMap<string, Stage> = new Map([
  ['● Origen', 'in_transit'],
  ['● Destino', 'in_transit'],
]);
