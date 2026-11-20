import type { Stage } from '../../core/status/index.js';

export const stages = new Map<string, Stage>([
  ['booked', 'registered'],
  ['accepted', 'accepted'],
  ['departed', 'in_transit'],
  ['arrived', 'in_transit'],
  ['delivered', 'delivered'],
]);
