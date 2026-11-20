import type { Stage } from '../../core/status/index.js';

export const stages = new Map<string, Stage>([
  ['Registrado', 'registered'],
  ['En ruta', 'in_transit'],
  ['En destino', 'in_transit'],
  ['Entregado', 'delivered'],
]);

export const manifestStatus = 'Despachado';
