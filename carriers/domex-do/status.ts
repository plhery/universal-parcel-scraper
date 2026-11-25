import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const stages: ReadonlyMap<string, Stage> = new Map(([
  ['Recibido (Origen)', 'accepted'],
  ['Empacado', 'in_transit'],
  ['Embarcado', 'in_transit'],
  ['Aduana', 'customs'],
  ['Recibido (Distribución)', 'in_transit'],
  ['Transferido', 'in_transit'],
  ['Inicio Transferencia Entrega', 'in_transit'],
  ['Transferencia Entrega', 'in_transit'],
  ['En Terminal', 'in_transit'],
  ['Disponible', 'ready_for_pickup'],
  ['Entregado Counter', 'delivered'],
] satisfies [string, Stage][]).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

// "Disponible (D03)" repeats the pickup notice on the parcel's third, fifth and later days at the counter.
const reminder = /^disponible \(d\d{2}\)$/;

function stageOf(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return stages.get(key) ?? (reminder.test(key) ? 'ready_for_pickup' : undefined);
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code === null ? stageOf(wording) : undefined,
  wholeWording: true,
  gaps: [
    ...['Facturado Online', 'Pago Confirmado'].map(wording => ({
      wording: normalizeStatusWording(wording),
      note: 'The tracker records billing and payment separately from parcel movement.',
    })),
    { wording: normalizeStatusWording('Cambio Destino'), note: 'A change of destination branch keeps the stage of the scan before it.' },
  ],
};
