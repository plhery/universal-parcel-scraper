import type { Stage } from '../../core/status/index.js';

export const stages = new Map<number, Stage>([
  [11, 'pending'],
  [16, 'in_transit'],
  [17, 'in_transit'],
  [21, 'in_transit'],
  [26, 'in_transit'],
  [27, 'in_transit'],
  [36, 'in_transit'],
  [73, 'accepted'],
]);
