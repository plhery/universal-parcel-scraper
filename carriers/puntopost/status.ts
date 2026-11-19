import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The status codes of PuntoPost's tracker, with the wording its page shows for
 * each. PuntoPost carries a parcel from the shop through its depots to one of
 * its pickup points (PuntoPost points), where the recipient collects it. A
 * parcel not collected goes back the same way (`return_*`).
 */
const CODES: Readonly<Record<string, { wording: string; stage: Stage }>> = {
  created: { wording: 'Guía generada', stage: 'registered' },
  in_origin_point: { wording: 'Tu envío se ha puesto en marcha', stage: 'accepted' },
  in_rerouted_point: { wording: 'Redirigiendo tu envío a otro PuntoPost', stage: 'in_transit' },
  in_transit_depot: { wording: 'En camino al almacén', stage: 'in_transit' },
  in_depot: { wording: 'En almacén', stage: 'in_transit' },
  in_transit_destination: { wording: 'En ruta hacia el punto de entrega', stage: 'in_transit' },
  in_destination_point: { wording: 'Disponible en punto de entrega', stage: 'ready_for_pickup' },
  delivered: { wording: 'Entregado', stage: 'delivered' },
  return_in_destination_point: { wording: 'Entrega fallida, inicio proceso de devolución', stage: 'returned' },
  return_in_transit_depot: { wording: 'Devolución en camino al almacén', stage: 'returned' },
  return_in_depot: { wording: 'Devolución en almacén', stage: 'returned' },
  return_in_transit_origin: { wording: 'Devolución en ruta hacia el punto de entrega', stage: 'returned' },
  return_in_origin_point: { wording: 'Devolución disponible en punto de entrega', stage: 'returned' },
  return_in_rerouted_point: { wording: 'Redirigiendo tu devolución a otro PuntoPost', stage: 'returned' },
  return_delivered: { wording: 'Devolución entregada', stage: 'returned' },
  incidence: { wording: 'Incidencia detectada, revisando', stage: 'exception' },
  cancelled: { wording: 'Cancelado', stage: 'exception' },
  lost: { wording: 'Siniestrado', stage: 'exception' },
};

/** What the page shows for every `return_fail*` code: the return ends at the sender. */
export const RETURN_FAIL_WORDING = 'Devolución al remitente';

export const isReturnFail = (code: string): boolean => code.startsWith('return_fail');

export function puntopostStage(code: string): Stage | undefined {
  return isReturnFail(code) ? 'returned' : CODES[code]?.stage;
}

/** The page's wording for a code; an unknown code shows as it came, as on the page. */
export function puntopostWording(code: string): string {
  return isReturnFail(code) ? RETURN_FAIL_WORDING : CODES[code]?.wording ?? code;
}

export const statusMap: CarrierStatusMap = { stage: code => code ? puntopostStage(code) : undefined, gaps: [] };
