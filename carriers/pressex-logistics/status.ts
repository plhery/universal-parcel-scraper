import type { Stage } from '../../core/status/index.js';

export const stages = new Map<string, Stage>([
  ['ENVIO CREADO', 'registered'],
  ['INGRESADA A BODEGA ORIGEN', 'accepted'],
  ['ENVIO AGREGADO A CONSOLIDADO', 'in_transit'],
  ['INGRESADO A BODEGA DESTINO', 'in_transit'],
  ['ENTREGADO', 'delivered'],
]);
