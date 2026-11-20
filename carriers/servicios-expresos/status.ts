import type { Stage } from '../../core/status/index.js';

export const stages: ReadonlyMap<string, Stage> = new Map([
  ['GENERADO', 'registered'],
  ['ADUANA USA', 'customs'],
  ['TRANSITO INTERNACIONAL', 'in_transit'],
  ['ADUANA VENEZUELA', 'customs'],
  ['CENTRAL CARACAS', 'in_transit'],
  ['TRANSITO NACIONAL', 'in_transit'],
  ['DISPONIBLE PARA ENTREGAR', 'in_transit'],
  ['ENTREGADO', 'delivered'],
]);
