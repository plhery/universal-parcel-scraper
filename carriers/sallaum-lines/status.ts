import type { Stage } from '../../core/status/index.js';

export const scanStages: ReadonlyMap<string, Stage> = new Map([
  ['Unit received', 'accepted'],
  ['Unit shipped', 'in_transit'],
  ['Unit discharged', 'in_transit'],
]);
