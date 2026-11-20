import type { Stage } from '../../core/status/index.js';

export const scanStages: ReadonlyMap<string, Stage> = new Map([
  ['INGRESADA EN POS', 'registered'],
  ['INGRESADA -VALIDADA', 'registered'],
  ['EN BODEGA ORIGEN', 'accepted'],
  ['DISTRIBUCION', 'in_transit'],
  ['ENTREGA SIN IMAGEN', 'delivered'],
  ['DEVOLUCION - DIGITALIZADA', 'exception'],
]);

export const administrativeScans = new Set(['CERTIFICACION', 'GUIA DIGITALIZADA', 'PLANILLADA A CENTRO DE ACOPIO DESDE POS']);
