import type { Stage } from '../../core/status/index.js';

export const stages = new Map<string, Stage>([
  ['101', 'registered'],
  ['112', 'accepted'],
  ['202', 'in_transit'],
  ['203', 'in_transit'],
  ['216', 'in_transit'],
  ['217', 'in_transit'],
  ['301', 'customs'],
  ['302', 'in_transit'],
  ['304', 'in_transit'],
  ['309', 'in_transit'],
  ['310', 'customs'],
  ['401', 'in_transit'],
  ['406', 'out_for_delivery'],
  ['407', 'delivered'],
]);
