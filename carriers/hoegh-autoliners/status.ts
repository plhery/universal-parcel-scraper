import type { Stage } from '../../core/status/index.js';

export const scanStages: ReadonlyMap<string, Stage> = new Map([
  ['Received', 'accepted'],
  ['Loaded', 'in_transit'],
  ['Discharged', 'in_transit'],
]);
