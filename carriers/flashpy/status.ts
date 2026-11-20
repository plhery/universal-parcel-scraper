import type { Stage } from '../../core/status/index.js';

export const stages: ReadonlyMap<string, Stage> = new Map([
  ['nuevo', 'registered'],
  ['proceso internacional', 'in_transit'],
]);
