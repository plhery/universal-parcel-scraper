import type { Stage } from '../../core/status/index.js';

const stages = new Map<string, Stage>([
  ['EN RUTA EXPRESS, LISTO PARA SER ENTREGADO', 'in_transit'],
  ['TRASBORDO, PENDIENTE DE ASIGNAR A RUTA', 'in_transit'],
  ['ENTREGADO SATISFACTORIAMENTE', 'delivered'],
]);

export function scanStage(phrase: string): Stage | undefined {
  return stages.get(phrase.toUpperCase());
}
