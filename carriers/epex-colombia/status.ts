import type { Stage } from '../../core/status/index.js';

export const scanStages: ReadonlyMap<string, Stage> = new Map([
  ['Registrado', 'registered'],
  ['Despachado', 'in_transit'],
  ['Descargado', 'in_transit'],
  ['Incidencia', 'exception'],
]);
