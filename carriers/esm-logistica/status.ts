import type { Stage } from '../../core/status/index.js';

export const stages: ReadonlyMap<string, Stage> = new Map([
  ['recibida en base de datos', 'registered'],
  ['en alistamiento en oficina de origen', 'accepted'],
  ['entregado', 'delivered'],
  ['no entregado', 'exception'],
]);
