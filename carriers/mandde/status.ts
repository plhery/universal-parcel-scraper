import type { Stage } from '../../core/status/index.js';

export const scanStages: ReadonlyMap<string, Stage> = new Map([
  ['USA', 'registered'],
  ['ICA', 'accepted'],
  ['DRD', 'in_transit'],
  ['RRD', 'in_transit'],
  ['REP', 'out_for_delivery'],
  ['ENT', 'delivered'],
]);
