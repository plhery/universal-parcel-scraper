import type { Stage } from '../../core/status/index.js';

export const statuses = new Map<string, { wording: string; stage?: Stage }>([
  ['BKD', { wording: 'Reservado para volar', stage: 'registered' }],
  ['RCS', { wording: 'Recibido en almacén origen', stage: 'accepted' }],
  ['PRE', { wording: 'Preparado para el vuelo' }],
  ['MAN', { wording: 'Incluido en el manifiesto' }],
  ['DEP', { wording: 'Despegó', stage: 'in_transit' }],
  ['ARR', { wording: 'Vuelo arribado', stage: 'in_transit' }],
  ['AWR', { wording: 'Documentación de llegada recibida' }],
  ['RCF', { wording: 'Carga recibida del vuelo', stage: 'in_transit' }],
  ['AWD', { wording: 'Documentación de llegada entregada' }],
  ['DLV', { wording: 'Entregado', stage: 'delivered' }],
]);
