import type { Stage } from '../../core/status/index.js';

export const stages = new Map<string, Stage>([
  ['Pickup Request Received', 'registered'],
  ['Picked Up', 'accepted'],
  ['Loaded On Trailer', 'in_transit'],
  ['Inbound Unloaded', 'in_transit'],
  ['Arrived Not Worked', 'in_transit'],
  ['En-route', 'in_transit'],
  ['Out For Delivery', 'out_for_delivery'],
  ['Delivered', 'delivered'],
  ['DELIVERY COMPLETE', 'delivered'],
  ['DELIVERY COMPLETED', 'delivered'],
]);

export const administrativeUpdates = new Set(['Manifested', 'Manifested For Delivery', 'Appointed']);
