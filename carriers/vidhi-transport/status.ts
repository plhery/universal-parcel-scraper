import type { Stage } from '../../core/status/index.js';

const statuses = new Map<string, { description: string; stage: Stage }>([
  ['0', { description: 'Booked', stage: 'registered' }],
  ['1', { description: 'On the way', stage: 'in_transit' }],
  ['2', { description: 'Delivered', stage: 'delivered' }],
]);

export function shipmentStatus(code: string) {
  return statuses.get(code);
}
