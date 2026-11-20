import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

// Rows by their wording, where the row's type alone says too little: a new guide and a packed
// order are both of the "inicio" type, and a contact attempt need not have failed.
const WORDING: ReadonlyMap<string, Stage> = new Map([
  ['guía generada', 'registered'],
  ['packing: pedido empacado', 'accepted'],
  ['en reparto', 'out_for_delivery'],
  ['intento de contacto sin respuesta', 'failed_attempt'],
  ['en devolución a la tienda', 'returned'],
  ['devolución en camino a la tienda', 'returned'],
  ['devuelto a la tienda', 'returned'],
]);

// The row types the tracker's page colours by, where the type alone settles the stage: transit,
// the delivery run, the delivery, a guide waiting at an office, the return to the shop and an
// incident. The shop, rescheduled, contact and start types say too little alone.
const TYPES: ReadonlyMap<string, Stage> = new Map([
  ['transito', 'in_transit'],
  ['reparto', 'out_for_delivery'],
  ['entregada', 'delivered'],
  ['retiro', 'ready_for_pickup'],
  ['devolucion', 'returned'],
  ['novedad', 'exception'],
]);

// The guide's own state, shown above the rows.
const STATES: ReadonlyMap<string, Stage> = new Map([
  ['devuelta', 'returned'],
]);

// The page's progress rail, by its step: generated, in transit, on the delivery run, delivered.
const STEPS: readonly Stage[] = ['registered', 'in_transit', 'out_for_delivery', 'delivered'];

/** The stage of a row, by its wording, then by its type; undefined for one the map does not know. */
export function gintracomStage(type: string | null, wording: string): Stage | undefined {
  return WORDING.get(normalizeStatusWording(wording.normalize('NFC'))) ?? (type ? TYPES.get(type.trim().toLowerCase()) : undefined);
}

/** The stage of the guide's own state code, or of its step on the progress rail. */
export function gintracomStateStage(code: string | null, step: number | null): Stage | undefined {
  return (code ? STATES.get(code.trim().toLowerCase()) : undefined) ?? (step === null ? undefined : STEPS[step]);
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => gintracomStage(code, wording),
  gaps: [],
};
