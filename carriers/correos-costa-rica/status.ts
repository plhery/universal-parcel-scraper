import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ["Admitido", "accepted"],
  ["Enviado al Centro de Proceso en Zapote para su Encaminamiento", "in_transit"],
  ["Llegada a la oficina de cambio", "in_transit"],
  ["Entrega a la Aduana", "customs"],
  ["Admitido en la Aduana. (Disponible para retiro)", "ready_for_pickup"],
  ['Tu envío fue entregado con éxito.', 'delivered'],
  ['Tu envío está en ruta de entrega. Recordá presentar tu identificación.', 'out_for_delivery'],
  ['Tu envío ha sido recibido en nuestra sucursal.', 'in_transit'],
  ['Tu envío está siendo trasladado a otra oficina de Correos dentro del país para continuar el recorrido hacia su destino final. Este evento aparecerá cada vez que hacemos un traslado interno.', 'in_transit'],
  ['Tu envío está en nuestro centro de distribución, donde se clasifica y se prepara para su traslado hacia la región de destino.', 'in_transit'],
  ['Tu envío se encuentra en proceso de devolución.', 'returned'],
  ['Entrega no concretada. Tu envío presentó una situación que impidió completar la entrega en este momento. Te recomendamos consultar futuras actualizaciones en nuestra sección de rastreo para conocer el avance del proceso.', 'failed_attempt'],
  ['Tu envío está disponible para retiro en nuestra sucursal.', 'ready_for_pickup'],
  ['Tu envío ha sido admitido en Correos de Costa Rica.', 'accepted'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
export function costaRicaStage(wording: string): Stage | undefined { return WORDINGS.get(normalizeStatusWording(wording)); }
export const statusMap: CarrierStatusMap = { stage: (code, wording) => code ? undefined : costaRicaStage(wording), gaps: [], wholeWording: true };
