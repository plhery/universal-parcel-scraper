import type { Stage } from '../../core/status/index.js';

export const stages: ReadonlyMap<string, Stage> = new Map([
  ['booked', 'registered'],
  ['dispatched', 'in_transit'],
  ['in transit', 'in_transit'],
  ['delivered', 'delivered'],
]);
