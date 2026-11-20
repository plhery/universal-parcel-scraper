import type { Stage } from '../../core/status/index.js';

export const stages = new Map<number, Stage>([
  [10, 'registered'],
  [11, 'accepted'],
  [30, 'in_transit'],
  [100, 'in_transit'],
  [200, 'in_transit'],
  [400, 'in_transit'],
  [700, 'delivered'],
]);
