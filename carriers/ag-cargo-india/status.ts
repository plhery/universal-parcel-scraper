import type { Stage } from '../../core/status/index.js';

export const statuses = new Map<string, { description: string; stage?: Stage }>([
  ['MANIFESTED', { description: 'Manifested', stage: 'registered' }],
  ['PICKED UP', { description: 'Picked Up', stage: 'accepted' }],
  ['IN TRANSIT', { description: 'In Transit', stage: 'in_transit' }],
  ['OUT FOR DELIVERY', { description: 'Out for Delivery', stage: 'out_for_delivery' }],
  ['DELIVERED', { description: 'Delivered', stage: 'delivered' }],
  ['RTO', { description: 'Returned', stage: 'returned' }],
  ['UNDELIVERED', { description: 'Undelivered' }],
]);
