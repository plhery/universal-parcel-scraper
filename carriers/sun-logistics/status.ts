import type { Stage } from '../../core/status/index.js';

export const stages = new Map<string, Stage>([
  ['Freight Unloaded', 'in_transit'],
  ['Scanned On Dock', 'in_transit'],
  ['Loaded On Trailer', 'in_transit'],
  ['Out For Delivery', 'out_for_delivery'],
  ['Delivered', 'delivered'],
]);
