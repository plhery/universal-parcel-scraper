import type { Stage } from '../../core/status/index.js';

export const scanStages: ReadonlyMap<string, Stage> = new Map([
  ['COLLECTED', 'accepted'],
  ['TENDERED @ JFK', 'in_transit'],
  ['ARRIVED IN LONDON', 'in_transit'],
  ['CLEARED CUSTOMS', 'customs'],
  ['DELIVERED', 'delivered'],
]);

export const scanLocations: ReadonlyMap<string, string> = new Map([
  ['TENDERED @ JFK', 'JFK'],
  ['ARRIVED IN LONDON', 'LONDON'],
]);
