import type { Stage } from '../../core/status/index.js';

export const map = new Map<string, { stage: Stage; description: string }>([
  ['PENDIENTE', { stage: 'pending', description: 'Pendiente' }],
  ['RECOGIDO', { stage: 'accepted', description: 'Recogido' }],
  ['EN_TRANSITO', { stage: 'in_transit', description: 'En tránsito' }],
  ['ENTREGADO', { stage: 'delivered', description: 'Entregado' }],
]);
