import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The states Szendex's tracker shows, in the normalized form. They come
 * without a code; another wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  // A service order: the pickup is requested, then given to a courier.
  ['solicitada', 'registered'],
  ['asignada', 'registered'],
  // The shipment's waybill is entered.
  ['documentado', 'registered'],
  ['recogida', 'accepted'],
  // The trace of its departure from the origin branch, which the page's rail calls Salida Delegacion.
  ['traza salida', 'in_transit'],
  ['salida delegacion', 'in_transit'],
  ['en agencia de destino', 'in_transit'],
  ['en reparto', 'out_for_delivery'],
  ['entregado', 'delivered'],
]);

/** The stage the map gives a state's wording. */
export function szendexMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A state's stage: its wording in the map, else the shared wording rules, else nothing. */
export function szendexStage(wording: string): ClassifiedWording | null {
  const mapped = szendexMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The tracker's states carry wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : szendexMappedStage(wording)),
  gaps: [],
};
