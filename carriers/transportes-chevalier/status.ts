import type { Stage } from '../../core/status/index.js';

export const scanStages: ReadonlyMap<string, Stage> = new Map([
  ['INGRESADO', 'registered'],
  ['EN BODEGA', 'accepted'],
  ['RUTA NACIONAL', 'in_transit'],
  ['EN BODEGA DESTINO', 'in_transit'],
  ['EN DISTRIBUCION', 'out_for_delivery'],
  ['ENTREGA SIN IMAGEN', 'delivered'],
]);

export const administrativeScans = new Set(['GUIA DIGITALIZADA', 'PREFACTURA']);
