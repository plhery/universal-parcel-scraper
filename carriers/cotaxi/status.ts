import type { Stage } from '../../core/status/index.js';

export const scanStages: ReadonlyMap<string, Stage> = new Map([
  ['GENERADA', 'registered'],
  ['EN BODEGA DE ORIGEN', 'accepted'],
  ['VIAJANDO', 'in_transit'],
  ['EN BODEGA INTERMEDIA', 'in_transit'],
  ['EN BODEGA DE DESTINO', 'in_transit'],
  ['ENTREGADA', 'delivered'],
]);

export const traceLabels = new Set([...scanStages.keys(), 'SALIENDO A DISTRIBUIDOR']);
