import type { Stage } from '../../core/status/index.js';

export const stages = new Map<string, Stage>([
  ['BOOKED DATE', 'registered'],
  ['LOADED TO VESSEL', 'in_transit'],
  ['VESSEL SAILED', 'in_transit'],
  ['VESSEL ARRIVED', 'in_transit'],
  ['CONTAINER DISCHARGED', 'in_transit'],
  ['CONTAINER OUTGATED', 'in_transit'],
  ['LOADED CONTAINER INGATED', 'in_transit'],
]);
