import type { Stage } from '../../core/status/index.js';

export const stages: ReadonlyMap<string, Stage> = new Map([
  ['outscan', 'in_transit'],
  ['inscan', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
  ['delivered successfully', 'delivered'],
]);
