import type { Stage } from '../../core/status/index.js';

export const movementStages: ReadonlyMap<string, Stage> = new Map([
  ['RECEIVED FULL EXPORT', 'accepted'],
  ['LOADED FULL ON VESSEL', 'in_transit'],
  ['LOADED EMPTY ON VESSEL', 'in_transit'],
  ['DISCHARGE FULL CONTAINER', 'in_transit'],
  ['DISCHARGED EMPTY CONTAINER', 'in_transit'],
  ['DISPATCHED EMPTY FOR EXPORT', 'in_transit'],
  ['EMPTY POSITIONING BY TRUCK', 'in_transit'],
  ['DELIVERED FULL IMPORT', 'delivered'],
]);

export const originMovements: ReadonlySet<string> = new Set([
  'LOADED FULL ON VESSEL', 'LOADED EMPTY ON VESSEL',
]);
