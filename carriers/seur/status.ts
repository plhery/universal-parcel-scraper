import type { ClassifiedStatus } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const delivered: ClassifiedStatus = { status: 'delivered', stage: 'delivered' };
const inTransit: ClassifiedStatus = { status: 'in_transit', stage: 'in_transit' };
const exception: ClassifiedStatus = { status: 'exception', stage: 'exception' };
const registered: ClassifiedStatus = { status: 'pending', stage: 'registered' };
const accepted: ClassifiedStatus = { status: 'in_transit', stage: 'accepted' };

// A null reading is a delay notice, not a movement: the scan keeps the stage of the one before it.
const observed: Record<string, { group: string; wording: string; mapped: ClassifiedStatus | null }> = {
  LL001: { group: 'ENTREGADO', wording: 'EL ENVÍO ESTÁ ENTREGADO.', mapped: delivered },
  LL003: { group: 'ENTREGADO', wording: 'EL ENVÍO ESTÁ ENTREGADO.', mapped: delivered },
  LL010: { group: 'ENTREGADO', wording: 'EL DESTINATARIO HA RETIRADO EL ENVÍO DE LA TIENDA SEUR PICKUP SELECCIONADA.', mapped: delivered },
  LL020: { group: 'ENTREGADO', wording: 'EL ENVÍO HA SIDO ENTREGADO A UN VECINO.', mapped: delivered },
  LC001: { group: 'EN REPARTO', wording: 'EL ENVÍO ESTÁ EN REPARTO.', mapped: { status: 'out_for_delivery', stage: 'out_for_delivery' } },
  LC003: { group: 'EN REPARTO', wording: 'EL ENVÍO ESTÁ EN REPARTO.', mapped: { status: 'out_for_delivery', stage: 'out_for_delivery' } },
  LI300: { group: 'EN DEMORA', wording: 'EL ENVÍO HA SUFRIDO UN RETRASO Y ES POSIBLE QUE SE DEMORE LA ENTREGA. DISCULPA LAS MOLESTIAS.', mapped: null },
  LI582: { group: 'EN DEMORA', wording: 'EL ENVÍO HA SUFRIDO UN RETRASO PROVOCANDO UNA POSIBLE DEMORA EN LA ENTREGA. DISCULPA LAS MOLESTIAS.', mapped: null },
  LI557: { group: 'EN DEMORA', wording: 'EL ENVÍO HA SUFRIDO UN RETRASO PROVOCANDO UNA POSIBLE DEMORA EN LA ENTREGA. DISCULPA LAS MOLESTIAS.', mapped: null },
  LI587: { group: 'EN DEMORA', wording: 'EL ENVÍO HA SUFRIDO UN RETRASO PROVOCANDO UNA POSIBLE DEMORA EN LA ENTREGA. DISCULPA LAS MOLESTIAS', mapped: null },
  // Recorded after the day's delivery round, which starts again the next day.
  LI521: { group: 'EN INCIDENCIA', wording: 'EL ENVÍO NO SE HA ENTREGADO PORQUE LA DIRECCIÓN DE ENTREGA ESTÁ INCOMPLETA O ERRÓNEA.', mapped: { status: 'exception', stage: 'failed_attempt' } },
  LI523: { group: 'EN INCIDENCIA', wording: 'EL ENVÍO NO SE HA ENTREGADO POR AUSENCIA O CIERRE. SE PUEDE REPROGRAMAR UNA NUEVA ENTREGA.', mapped: { status: 'exception', stage: 'failed_attempt' } },
  // During the round to a SEUR Pickup point, the point could not take the parcel; SEUR names another point a minute later.
  LI503: { group: 'EN INCIDENCIA', wording: 'NO SE HA PODIDO DEPOSITAR EL ENVÍO EN EL PUNTO SOLICITADO', mapped: { status: 'exception', stage: 'failed_attempt' } },
  LI524: { group: 'EN INCIDENCIA', wording: 'EL ENVÍO NO SE HA ENTREGADO PORQUE NO ES LA DIRECCIÓN ACTUAL DEL DESTINATARIO.', mapped: exception },
  // The recipient has to act: pick another point, or send customs the invoice.
  LI573: { group: 'EN INCIDENCIA', wording: 'EL ENVÍO NO HA SIDO DEPOSITADO EN EL LOCKER SELECCIONADO. SE DEBE ELEGIR OTRO PUNTO SEUR PICKUP.', mapped: exception },
  LI717: { group: 'EN INCIDENCIA', wording: 'INCIDENCIA EN ADUANAS: FALTA FACTURA. CONTACTA CON SEUR DESDE EL ÁREA DE SOPORTE.', mapped: exception },
  LI530: { group: 'ENTREGA EN TIENDA', wording: 'EL ENVÍO ESTÁ DISPONIBLE PARA RECOGER EN EL PUNTO SEUR PICKUP.', mapped: { status: 'in_transit', stage: 'ready_for_pickup' } },
  // The shop's notice that the parcel can soon be collected, its details still to come, then its release, worded as LI530.
  LI569: { group: 'ENTREGA EN TIENDA', wording: 'EN BREVE PODRÁS RECOGER TU ENVÍO. RECIBIRÁS UNA NOTIFICACIÓN CON LOS DETALLES', mapped: inTransit },
  LI574: { group: 'ENTREGA EN TIENDA', wording: 'EL ENVÍO ESTÁ DISPONIBLE PARA RECOGER EN EL PUNTO SEUR PICKUP.', mapped: { status: 'in_transit', stage: 'ready_for_pickup' } },
  // Pending arrival at the destination's facility: in the delay group, but it says where the parcel is.
  LI511: { group: 'EN DEMORA', wording: 'EL ENVÍO ESTÁ PENDIENTE DE LLEGAR A DESTINO. EN CUANTO SE RECIBA, ACTUALIZAREMOS LA SITUACIÓN.', mapped: inTransit },
  LI567: { group: 'EN TRÁNSITO', wording: 'EL ENVÍO ESTÁ EN TRÁNSITO. PRÓXIMAMENTE LLEGARÁ A LAS INSTALACIONES DE DESTINO.', mapped: inTransit },
  LO001: { group: 'EN TRÁNSITO', wording: 'EL ENVÍO ESTÁ EN TRÁNSITO. PRÓXIMAMENTE LLEGARÁ A LAS INSTALACIONES DE DESTINO.', mapped: inTransit },
  SW189: { group: 'EN TRÁNSITO', wording: 'EL ENVÍO ESTÁ EN TRÁNSITO. PRÓXIMAMENTE LLEGARÁ A LAS INSTALACIONES DE DESTINO.', mapped: inTransit },
  LT859: { group: 'EN TRÁNSITO', wording: 'EL ENVÍO ESTÁ EN TRÁNSITO INTERNACIONAL. PRÓXIMAMENTE LLEGARÁ A LAS INSTALACIONES DE DESTINO.', mapped: inTransit },
  // An agreed day or a redirection to a pickup point keeps the parcel on its way.
  LJ100: { group: 'EN TRÁNSITO', wording: 'EL ENVÍO SERÁ ENTREGADO EN LA FECHA CONCERTADA. ACTUALIZAREMOS LA SITUACIÓN.', mapped: inTransit },
  LJ105: { group: 'EN TRÁNSITO', wording: 'LOS DATOS DEL ENVÍO HAN SIDO MODIFICADOS Y SE ENTREGARÁ EN UN PUNTO SEUR PICKUP.', mapped: inTransit },
  LD221: { group: 'EN ADUANAS', wording: 'EL ENVÍO HA LLEGADO A LA ADUANA DE DESTINO. INICIAMOS LOS TRÁMITES DE DESPACHO ADUANERO.', mapped: { status: 'in_transit', stage: 'customs' } },
  LI580: { group: 'EN ADUANAS', wording: 'EL ENVÍO ESTÁ EN GESTIÓN POR LA ADUANA. TRAMITANDO DESPACHO ADUANERO.', mapped: { status: 'in_transit', stage: 'customs' } },
  // Cleared and about to go out for delivery.
  LD223: { group: 'EN ADUANAS', wording: 'LA MERCANCÍA HA SIDO DESPACHADA Y PRÓXIMAMENTE SALDRÁ A REPARTO.', mapped: inTransit },
  // The pickup made on a pickup reference, before SEUR's origin facility receives the parcel.
  SX605: { group: 'EN TRÁNSITO', wording: 'LA RECOGIDA HA SIDO REALIZADA.', mapped: { status: 'in_transit', stage: 'accepted' } },
  SX001: { group: 'EN TRÁNSITO', wording: 'EL ENVÍO HA SIDO RECEPCIONADO EN LAS INSTALACIONES DE ORIGEN DE SEUR. COMIENZA EL TRÁNSITO A DESTINO', mapped: { status: 'in_transit', stage: 'accepted' } },
  SX010: { group: 'NOTIFICADO', wording: 'EL ENVÍO HA SIDO REGISTRADO.', mapped: registered },
  SC999: { group: 'NOTIFICADO', wording: 'EL ENVÍO HA SIDO REGISTRADO.', mapped: registered },
  // A collection from the sender. Booked, changed, or confirmed by the courier on the day's round, it registers the
  // shipment; a collection that failed leaves the parcel with the sender, no delivery attempt. The collection made, or
  // the sender's drop at a SEUR Pickup point, is the acceptance.
  GO003: { group: 'SOLICITUD REGISTRADA', wording: 'LA RECOGIDA HA SIDO REGISTRADA.', mapped: registered },
  GO002: { group: 'SOLICITUD REGISTRADA', wording: 'LA RECOGIDA HA SIDO REGISTRADA.', mapped: registered },
  GO001: { group: 'SOLICITUD REGISTRADA', wording: 'LA RECOGIDA HA SIDO MODIFICADA.', mapped: registered },
  GC002: { group: 'RECOGIDA CONFIRMADA', wording: 'LA RECOGIDA HA SIDO CONFIRMADA POR EL REPATIDOR.', mapped: registered },
  GI650: { group: 'EN INCIDENCIA', wording: 'RECOGIDA NO REALIZADA: CLIENTE CERRADO O AUSENTE. SE PUEDE REPROGRAMAR UNA NUEVA FECHA DE RECOGIDA.', mapped: registered },
  GL001: { group: 'RECOGIDA REALIZADA', wording: 'LA RECOGIDA HA SIDO REALIZADA.', mapped: accepted },
  GO008: { group: 'ENVÍO DEPOSITADO', wording: 'EL ENVÍO HA SIDO DEPOSITADO EN UN PUNTO SEUR PICKUP.', mapped: accepted },
};

// SEUR's delay notices, which it files under ever more codes of its EN DEMORA group, with or without the last full stop.
const DELAY_WORDINGS = new Set([
  'el envío ha sufrido un retraso y es posible que se demore la entrega. disculpa las molestias',
  'el envío ha sufrido un retraso provocando una posible demora en la entrega. disculpa las molestias',
]);
const DELAY_NOTE = 'A delay notice, not a movement: the parcel keeps the stage it had.';
const delayWording = (wording: string) => DELAY_WORDINGS.has(normalizeStatusWording(wording).replace(/\.$/, ''));

function entry(code: string, group: string, wording: string) {
  if (!Object.hasOwn(observed, code)) return undefined;
  const found = observed[code]!;
  return group.toUpperCase() === found.group && wording.toUpperCase() === found.wording ? found : undefined;
}

export function classifySeurStatus(code: string, group: string, wording: string): ClassifiedStatus | undefined {
  return entry(code, group, wording)?.mapped ?? undefined;
}

/** Whether the scan is one of SEUR's delay notices, which keep the stage the parcel had, under a code seen or not. */
export function isSeurDelay(code: string, group: string, wording: string): boolean {
  const found = entry(code, group, wording);
  return found ? found.mapped === null : group.toUpperCase() === 'EN DEMORA' && delayWording(wording);
}

/** The status group SEUR sent with an observed code. */
export function seurStatusGroup(code: string): string | undefined {
  return Object.hasOwn(observed, code) ? observed[code]!.group : undefined;
}

/** What the map says about one scan, read with the group SEUR sends with its code. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? classifySeurStatus(code, seurStatusGroup(code) ?? '', wording)?.stage : undefined),
  gaps: ['LI300', 'LI582', 'LI557', 'LI587'].map((code) => ({ code, note: DELAY_NOTE })),
  gapNote: (_code, wording) => (delayWording(wording) ? DELAY_NOTE : undefined),
};
