import type { Stage } from '../../core/status/index.js';

export const summaryStages: ReadonlyMap<string, Stage> = new Map([
  ['10', 'accepted'],
  ['15', 'delivered'],
  ['99', 'exception'],
]);

export const eventStages: ReadonlyMap<string, Stage> = new Map([
  ['Order scheduled via telephone', 'registered'],
  ['Drop-off completed in', 'delivered'],
  ['Shipment acknowledged as canceled.', 'exception'],
]);
