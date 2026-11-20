import type { Stage } from '../../core/status/index.js';

export const stages = new Map<string, Stage>([
  ['Booking confirmed', 'registered'],
  ['Picked up from shipper', 'accepted'],
  ['Departed origin port on vessel', 'in_transit'],
  ['Loaded on vessel', 'in_transit'],
  ['Departed transshipment port', 'in_transit'],
  ['Customs cleared', 'customs'],
  ['Arrived at destination port on vessel', 'in_transit'],
  ['Departed from international terminal', 'in_transit'],
  ['Delivery complete', 'delivered'],
  ['Delivered', 'delivered'],
]);
