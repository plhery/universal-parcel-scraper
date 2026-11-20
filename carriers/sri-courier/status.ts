import type { Stage } from '../../core/status/index.js';

export const stages = new Map<string, Stage>([
  ['Order Placed', 'registered'],
  ['Picked Up', 'accepted'],
  ['In Transit', 'in_transit'],
  ['Out for Delivery', 'out_for_delivery'],
  ['Delivered', 'delivered'],
]);
