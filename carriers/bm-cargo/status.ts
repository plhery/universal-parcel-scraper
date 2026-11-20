import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const stages: ReadonlyMap<string, Stage> = new Map(([
  ['Recibido en Miami', 'accepted'],
  ['Empacado', 'in_transit'],
  ['Entregado Linea Aerea', 'in_transit'],
  ['Embarcado', 'in_transit'],
  ['Recibido AILA', 'in_transit'],
  ['En ruta a Sucursal', 'in_transit'],
  ['Recibido en Sucursal', 'in_transit'],
  ['Disponible', 'ready_for_pickup'],
  ['Entregado', 'delivered'],
] satisfies [string, Stage][]).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code === null ? stages.get(normalizeStatusWording(wording)) : undefined,
  wholeWording: true,
  gaps: ['Facturado Online', 'Pago Confirmado', 'Retiro Notificado'].map(wording => ({
    wording: normalizeStatusWording(wording),
    note: 'The tracker records billing, payment and collection notices separately from parcel movement.',
  })),
};
