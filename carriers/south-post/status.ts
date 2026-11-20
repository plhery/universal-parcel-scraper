import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, statusGapNote, type CarrierStatusMap } from '../../core/status/statusMap.js';

// The tracking page's script reads each scan's `estado` in lower case and groups the wordings
// into the steps of its rail: preparing the order, ready to deliver, on the way, delivered.
// Its problem wordings each get a message of their own; those it explains are staged here.
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  // Preparación: the shop prepares the order, or South Post picks it from the shop's stock.
  ['pendiente de retiro', 'registered'],
  ['pendiente de stock', 'registered'],
  ['pendiente', 'registered'],
  ['picking', 'registered'],
  ['armado', 'registered'],
  // Listo para entregar: South Post has the parcel, ready to send.
  ['recibido en south post', 'accepted'],
  ['recibido en casa central', 'accepted'],
  ['retiro en planta', 'accepted'],
  ['programacion', 'accepted'],
  // En camino: travelling to, or arrived at, the branch in charge of the delivery.
  ['tránsito a sucursal.', 'in_transit'],
  ['transito a sucursal', 'in_transit'],
  ['programacion suc', 'in_transit'],
  ['programacion suc.', 'in_transit'],
  ['despachado a sucursal gire', 'in_transit'],
  // "On <date> we will visit your address."
  ['en distribucion.', 'out_for_delivery'],
  ['en distribucion', 'out_for_delivery'],
  ['recibido en punto de entrega', 'ready_for_pickup'],
  ['retira en planta', 'ready_for_pickup'],
  ['entregada', 'delivered'],
  ['retirado', 'delivered'],
  // "We went to your address and did not find you."
  ['1° visita no responde.', 'failed_attempt'],
  ['2° visita no responde.', 'failed_attempt'],
  // "We could not complete your delivery": the page asks the reader to pick a collection point.
  ['custodia', 'failed_attempt'],
  // The page's delivery problems: "we could not deliver your parcel, contact customer care".
  ...[
    'se encuentra de vacaciones', 'se encuentra de vacaciones.', 'zona intransitable / inundada', 'desconoce destinatario',
    'no existe numero', 'domicilio incompleto', 'se rehúsan a recibir el envío', 'informan que el destinatario falleció',
    'el destinatario se mudó', 'no existe calle', 'siniestro', 'no entrega por mal estado', 'envío anulado por el destinatario',
    'visitas reiteradas', 'zona peligrosa', 'datos confusos',
  ].map(wording => [wording, 'exception'] as const),
  ['anulado', 'exception'],
  ['retornando a casa central', 'exception'],
  ['devolución recibida', 'returned'],
  ['devuelto al remitente', 'returned'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

// Left without a stage: "custodia." and "retiro efectuado", which the page explains only as a
// matter for customer care or a collection to go back to the shop, and its exchange and recovery
// wordings, which it reports as managing the order.

/** The stage of a scan's wording, or undefined for one the page does not explain or does not list. */
export function southPostStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => southPostStage(wording),
  wholeWording: true,
  gaps: [
    { code: '118', wording: 'no visitado', note: 'A visit the page says technical problems put off, promising another within two working days; the parcel keeps its stage.' },
    { wording: 'no visitado', note: 'A visit the page says technical problems put off, promising another within two working days; the parcel keeps its stage.' },
  ],
};

/** A scan's stage: the map, else the shared wording rules, else none. */
export function scanStage(wording: string): ClassifiedWording | null {
  const mapped = southPostStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  // A wording the map leaves without a stage on purpose keeps none.
  if (statusGapNote(statusMap, null, normalizeStatusWording(wording)) !== undefined) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}
