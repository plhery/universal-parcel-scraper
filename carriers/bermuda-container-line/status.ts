import type { Stage } from '../../core/status/index.js';

export const stages = new Map<string, Stage>([
  ['In-Gate (322)', 'accepted'],
  ['Loaded on Vessel', 'in_transit'],
  ['Unloaded From Vessel', 'in_transit'],
  ['Out-Gate', 'in_transit'],
]);
