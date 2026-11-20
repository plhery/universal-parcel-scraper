import type { Stage } from '../../core/status/index.js';

export const stages = new Map<string, Stage>([
  ['booking confirmed', 'registered'],
  ['received from shipper', 'accepted'],
  ['manifested', 'in_transit'],
  ['departed', 'in_transit'],
  ['arrived', 'in_transit'],
  ['received from flight', 'in_transit'],
  ['notified', 'in_transit'],
  ['documents delivered', 'in_transit'],
  ['delivered', 'delivered'],
]);
