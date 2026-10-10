import type { ClassifiedStatus } from '../../core/status/index.js';

const delivered: ClassifiedStatus = { status: 'delivered', stage: 'delivered' };
const inTransit: ClassifiedStatus = { status: 'in_transit', stage: 'in_transit' };
const exception: ClassifiedStatus = { status: 'exception', stage: 'exception' };

const observed: Record<string, { group: string; wording: string; mapped: ClassifiedStatus }> = {
  LL003: { group: 'ENTREGADO', wording: 'EL ENVÍO ESTÁ ENTREGADO.', mapped: delivered },
  LL010: { group: 'ENTREGADO', wording: 'EL DESTINATARIO HA RETIRADO EL ENVÍO DE LA TIENDA SEUR PICKUP SELECCIONADA.', mapped: delivered },
  LL020: { group: 'ENTREGADO', wording: 'EL ENVÍO HA SIDO ENTREGADO A UN VECINO.', mapped: delivered },
  LC003: { group: 'EN REPARTO', wording: 'EL ENVÍO ESTÁ EN REPARTO.', mapped: { status: 'out_for_delivery', stage: 'out_for_delivery' } },
  LI300: { group: 'EN DEMORA', wording: 'EL ENVÍO HA SUFRIDO UN RETRASO Y ES POSIBLE QUE SE DEMORE LA ENTREGA. DISCULPA LAS MOLESTIAS.', mapped: exception },
  LI582: { group: 'EN DEMORA', wording: 'EL ENVÍO HA SUFRIDO UN RETRASO PROVOCANDO UNA POSIBLE DEMORA EN LA ENTREGA. DISCULPA LAS MOLESTIAS.', mapped: exception },
  LI523: { group: 'EN INCIDENCIA', wording: 'EL ENVÍO NO SE HA ENTREGADO POR AUSENCIA O CIERRE. SE PUEDE REPROGRAMAR UNA NUEVA ENTREGA.', mapped: { status: 'exception', stage: 'failed_attempt' } },
  LI524: { group: 'EN INCIDENCIA', wording: 'EL ENVÍO NO SE HA ENTREGADO PORQUE NO ES LA DIRECCIÓN ACTUAL DEL DESTINATARIO.', mapped: exception },
  LI530: { group: 'ENTREGA EN TIENDA', wording: 'EL ENVÍO ESTÁ DISPONIBLE PARA RECOGER EN EL PUNTO SEUR PICKUP.', mapped: { status: 'in_transit', stage: 'ready_for_pickup' } },
  LI567: { group: 'EN TRÁNSITO', wording: 'EL ENVÍO ESTÁ EN TRÁNSITO. PRÓXIMAMENTE LLEGARÁ A LAS INSTALACIONES DE DESTINO.', mapped: inTransit },
  LO001: { group: 'EN TRÁNSITO', wording: 'EL ENVÍO ESTÁ EN TRÁNSITO. PRÓXIMAMENTE LLEGARÁ A LAS INSTALACIONES DE DESTINO.', mapped: inTransit },
  // An agreed day or a redirection to a pickup point keeps the parcel on its way.
  LJ100: { group: 'EN TRÁNSITO', wording: 'EL ENVÍO SERÁ ENTREGADO EN LA FECHA CONCERTADA. ACTUALIZAREMOS LA SITUACIÓN.', mapped: inTransit },
  LJ105: { group: 'EN TRÁNSITO', wording: 'LOS DATOS DEL ENVÍO HAN SIDO MODIFICADOS Y SE ENTREGARÁ EN UN PUNTO SEUR PICKUP.', mapped: inTransit },
  LD221: { group: 'EN ADUANAS', wording: 'EL ENVÍO HA LLEGADO A LA ADUANA DE DESTINO. INICIAMOS LOS TRÁMITES DE DESPACHO ADUANERO.', mapped: { status: 'in_transit', stage: 'customs' } },
  // Cleared and about to go out for delivery.
  LD223: { group: 'EN ADUANAS', wording: 'LA MERCANCÍA HA SIDO DESPACHADA Y PRÓXIMAMENTE SALDRÁ A REPARTO.', mapped: inTransit },
  SX001: { group: 'EN TRÁNSITO', wording: 'EL ENVÍO HA SIDO RECEPCIONADO EN LAS INSTALACIONES DE ORIGEN DE SEUR. COMIENZA EL TRÁNSITO A DESTINO', mapped: { status: 'in_transit', stage: 'accepted' } },
  SX010: { group: 'NOTIFICADO', wording: 'EL ENVÍO HA SIDO REGISTRADO.', mapped: { status: 'pending', stage: 'registered' } },
};

export function classifySeurStatus(code: string, group: string, wording: string): ClassifiedStatus | undefined {
  if (!Object.hasOwn(observed, code)) return undefined;
  const entry = observed[code]!;
  return group.toUpperCase() === entry.group && wording.toUpperCase() === entry.wording ? entry.mapped : undefined;
}

/** The status group SEUR sent with an observed code. */
export function seurStatusGroup(code: string): string | undefined {
  return Object.hasOwn(observed, code) ? observed[code]!.group : undefined;
}
