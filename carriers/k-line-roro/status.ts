import type { Stage } from '../../core/status/index.js';

export const scanStages: ReadonlyMap<string, Stage> = new Map([
  ['Actual Departure', 'in_transit'],
  ['Actual Arrival', 'in_transit'],
]);
