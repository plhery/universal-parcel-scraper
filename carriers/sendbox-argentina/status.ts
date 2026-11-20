import type { Stage } from '../../core/status/index.js';

export const summaryStages: ReadonlyMap<string, Stage> = new Map([
  ['entregado', 'delivered'],
  ['cancelado', 'exception'],
  ['disponible para retiro', 'ready_for_pickup'],
]);
