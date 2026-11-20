import type { Stage } from '../../core/status/index.js';

export const scanStages: ReadonlyMap<string, Stage> = new Map([
  ['DEPARTED', 'in_transit'],
  ['DISCHARGED', 'in_transit'],
]);
