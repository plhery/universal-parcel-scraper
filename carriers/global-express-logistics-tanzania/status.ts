import type { Stage } from '../../core/status/index.js';

export const statuses = new Map<string, { label: string; stage?: Stage }>([
  ['pending', { label: 'Order Created', stage: 'pending' }],
  ['assigned', { label: 'Courier Assigned', stage: 'registered' }],
  ['picked_up', { label: 'Picked Up', stage: 'accepted' }],
  ['in_transit', { label: 'In Transit', stage: 'in_transit' }],
  ['delivered', { label: 'Delivered', stage: 'delivered' }],
  ['confirmed', { label: 'Confirmed' }],
]);
