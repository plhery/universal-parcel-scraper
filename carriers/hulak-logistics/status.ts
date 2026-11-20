import type { Stage } from '../../core/status/index.js';

export const statuses = new Map<string, { label: string; stage: Stage }>([
  ['pickup order created', { label: 'Pickup Order Created', stage: 'registered' }],
  ['drop off order collected', { label: 'Drop Off Order Collected', stage: 'accepted' }],
  ['dispatched', { label: 'Dispatched', stage: 'in_transit' }],
  ['arrived', { label: 'Arrived', stage: 'in_transit' }],
  ['sent for delivery', { label: 'Sent For Delivery', stage: 'out_for_delivery' }],
  ['delivered', { label: 'Delivered', stage: 'delivered' }],
]);
