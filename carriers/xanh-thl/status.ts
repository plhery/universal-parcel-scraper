import type { Stage } from '../../core/status/index.js';

export const scanStages: ReadonlyMap<string, Stage> = new Map([
  ['Shipment picked up', 'accepted'],
  ['Delivery in progress', 'in_transit'],
]);
