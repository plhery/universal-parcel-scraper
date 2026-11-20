import type { Stage } from '../../core/status/index.js';

export const scanStages: ReadonlyMap<string, Stage> = new Map([
  ['Booked', 'registered'],
  ['Received From Shipper', 'accepted'],
  ['Manifested on Flight', 'in_transit'],
  ['Departed on Flight', 'in_transit'],
  ['Departed', 'in_transit'],
  ['Received From Flight', 'in_transit'],
  ['Delivered', 'delivered'],
]);

export const routeEndpoint: ReadonlyMap<string, 'origin' | 'destination'> = new Map([
  ['Received From Shipper', 'origin'],
  ['Manifested on Flight', 'origin'],
  ['Departed on Flight', 'origin'],
  ['Departed', 'origin'],
  ['Received From Flight', 'destination'],
  ['Delivered', 'destination'],
]);
