import type { Stage } from '../../core/status/index.js';

export const scanStages: ReadonlyMap<string, Stage> = new Map([
  ['PKF', 'accepted'],
  ['SFF', 'in_transit'],
  ['GIF', 'in_transit'],
  ['VLF', 'in_transit'],
  ['VUF', 'in_transit'],
  ['GOF', 'in_transit'],
]);
