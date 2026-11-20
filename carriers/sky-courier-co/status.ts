import type { Stage } from '../../core/status/index.js';

const statuses = new Map<string, { description: string; stage: Stage }>([
  ['EN_PROCESO', { description: 'Pre-Alerta Creada', stage: 'registered' }],
  ['RECIBIDO_EN_BODEGA', { description: 'Recibido en Bodega', stage: 'accepted' }],
  ['CONSOLIDADO', { description: 'Consolidado', stage: 'in_transit' }],
  ['ETIQUETA_CREADA', { description: 'Etiqueta Creada', stage: 'registered' }],
  ['READY_TO_SHIP', { description: 'Listo para Envío', stage: 'registered' }],
  ['EN_TRANSITO', { description: 'En Tránsito', stage: 'in_transit' }],
  ['LLEGADA_AEROPUERTO', { description: 'Llegada a Aeropuerto', stage: 'in_transit' }],
  ['TRANSITO_ADUANERO', { description: 'Tránsito Aduanero', stage: 'customs' }],
  ['PAGO_IMPUESTOS', { description: 'Pago de Impuestos', stage: 'customs' }],
  ['RETENIDO_EN_ADUANA', { description: 'Retenido en Aduana', stage: 'customs' }],
  ['LIBERADO', { description: 'Liberado', stage: 'in_transit' }],
  ['ENTREGADO_ADUANA', { description: 'Entregado desde Aduana', stage: 'in_transit' }],
  ['EN_BODEGA_LOCAL', { description: 'En Bodega Local', stage: 'in_transit' }],
  ['ENTREGADO', { description: 'Entregado', stage: 'delivered' }],
  ['DELIVERED', { description: 'Entregado', stage: 'delivered' }],
]);

export function shipmentStatus(code: string) {
  return statuses.get(code);
}
