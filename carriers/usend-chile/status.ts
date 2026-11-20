import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** USEND's movement wordings, in `normalizeStatusWording` form, as its guest tracker writes them. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['servicio creado', 'registered'], // The guide created, often from a shipper's bulk upload.
  ['recibimos en origen', 'accepted'],
  ['despachamos a su destino', 'in_transit'],
  ['arribo en ciudad destino', 'in_transit'],
  ['entregado a tercero', 'delivered'], // Delivered to someone other than the addressee.
]);
// A courier's run, with the visit's number in brackets: "(Primera Visita)".
const OUT_FOR_DELIVERY = /^salio a entregarse(?: \([a-záéíóúñ ]+visita\))?$/;

/** The stage USEND's own wording gives a movement, read whole. */
export function usendMappedStage(wording: string): Stage | undefined {
  const key = wording.toLocaleLowerCase('es').trim().split(/\s+/).join(' ');
  return WORDINGS.get(key) ?? (OUT_FOR_DELIVERY.test(key) ? 'out_for_delivery' : undefined);
}

/** A movement's stage: USEND's wording, else the shared wording rules, else nothing. */
export function usendStage(wording: string): ClassifiedWording | null {
  const mapped = usendMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  stage: (code, wording) => (code ? undefined : usendMappedStage(wording)),
  gaps: [],
};
