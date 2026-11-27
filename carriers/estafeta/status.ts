import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

export function estafetaWording(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase();
}

const WORDINGS = new Map<string, ClassifiedStatus>([
  ['entregado', { status: 'delivered', stage: 'delivered' }],
  ['en proceso de entrega a domicilio', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['en transito', { status: 'in_transit', stage: 'in_transit' }],
  ['recibido por estafeta', { status: 'in_transit', stage: 'accepted' }],
  ['carga demorada por bloqueo o accidente externo en via federal', { status: 'exception', stage: 'exception' }],
  ['pendiente programacion para salida a ruta (ver fecha programada de entrega )', { status: 'in_transit', stage: 'in_transit' }],
]);

/** The notice that holds a parcel until it is scheduled for a round. */
export function estafetaRoundNotice(description: string): boolean {
  return estafetaWording(description).startsWith('pendiente programacion para salida a ruta');
}

export function estafetaStatus(wording: string): ClassifiedStatus | undefined {
  const normalized = estafetaWording(wording);
  if (/^.+ llegada a centro operativo plaza destino$/.test(normalized)) return { status: 'in_transit', stage: 'in_transit' };
  // The sender's drop-off at an office, named by its address, at the minute of "Recibido por Estafeta".
  if (/^envio recibido en oficina \S/.test(normalized)) return { status: 'in_transit', stage: 'accepted' };
  return WORDINGS.get(normalized);
}

// A notice that the delivery may run late, with its cause: "Posible demora en la entrega por …".
const DELAY_NOTICE = /^posible demora en la entrega\b/;

/** What the map says about one scan: its Spanish wording, as the parser reads it. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => estafetaStatus(wording)?.stage,
  gaps: [],
  gapNote: (_code, wording) => DELAY_NOTICE.test(estafetaWording(wording))
    ? 'A notice that the delivery may run late, with its cause: not a step, so the parcel keeps the stage it had.' : undefined,
};
