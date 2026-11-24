import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Paket's shipment states, the `estado` of each history row and of the shipment, in Spanish.
 * Each state comes with one fixed title and sentence. Only the states seen in replies are
 * mapped. State 4 is titled "En tránsito" but says the parcel is out for delivery, the page's
 * "En reparto" step.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['1', 'registered'], // Por Retirar: Paket has not collected the order from the shop yet.
  ['2', 'accepted'], // Retirado: Paket collected it from the shop.
  ['4', 'out_for_delivery'], // En tránsito: "Tu pedido está en reparto".
  ['5', 'delivered'], // Entregado.
]);

/** The stage Paket's map gives a state code, if it knows it. */
export function paketMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A history row's stage: its state code, else the shared wording rules, else nothing. */
export function paketStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = paketMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * The page's headline for a parcel with an alert, by the reply's `progreso.alerta`, and for
 * one it marks as lost. A return under way is an exception until the parcel is back at the
 * shop. "Consultar" sends the reader to the shop and says nothing of the parcel.
 */
const ALERTS: ReadonlyMap<string, { stage?: Stage; label: string }> = new Map([
  ['fallido', { stage: 'failed_attempt', label: 'No pudimos entregarlo' }],
  ['no_recibido', { stage: 'exception', label: 'Paket no tiene este pedido' }],
  ['devolviendo', { stage: 'exception', label: 'Tu pedido va de vuelta a la tienda' }],
  ['devuelto', { stage: 'returned', label: 'Tu pedido volvió a la tienda' }],
  ['consultar', { label: 'Consulta con la tienda' }],
]);
export const PAKET_LOST = { stage: 'exception', label: 'Estamos buscando tu pedido' } as const satisfies { stage: Stage; label: string };

/** The page's headline and its stage for an alert it names. */
export function paketAlert(alert: string): { stage?: Stage; label: string } | undefined {
  return ALERTS.get(alert);
}

/** The steps of the page's progress rail, by `progreso.paso`. */
const STEPS: readonly (readonly [Stage, string])[] = [
  ['registered', 'Por retirar'],
  ['accepted', 'Retirado'],
  ['in_transit', 'En bodega'],
  ['out_for_delivery', 'En reparto'],
  ['delivered', 'Entregado'],
];

/** The stage and label of a step of the page's rail. */
export function paketStep(step: number): { stage: Stage; label: string } | undefined {
  const known = STEPS[step];
  return known ? { stage: known[0], label: known[1] } : undefined;
}

/** History rows and a shipment without rows carry a state code. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? paketMappedStage(code) : undefined),
  gaps: [],
};
