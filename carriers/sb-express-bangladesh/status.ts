import type { Stage } from '../../core/status/index.js';

export const statuses = new Map<string, { label: string; stage: Stage }>([
  ['picked up', { label: 'Picked up', stage: 'accepted' }],
  ['hub received', { label: 'Hub received', stage: 'in_transit' }],
  ['out for delivery', { label: 'Out for delivery', stage: 'out_for_delivery' }],
  ['delivered', { label: 'Delivered', stage: 'delivered' }],
]);
