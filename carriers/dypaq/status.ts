import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * DYPAQ's movement wording, in `normalizeStatusWording` form, as its tracker
 * gives it. The tracker gives no codes. Other wording falls to the shared
 * rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  // The merchant documented the shipment on its own site, then DYPAQ collected it there.
  ['envío pre-documentado en sitio web del cliente', 'registered'],
  ['recoleccion', 'accepted'],
  ['confirmacion de entrega', 'delivered'],
]);

/** Wording that names a circuit or a route after a fixed start. */
const PREFIXES: readonly (readonly [RegExp, Stage])[] = [
  // Loaded onto a line haul between DYPAQ's offices, or the one collecting in a town.
  [/^embarcado a circuito\b/, 'in_transit'],
  // Loaded onto a delivery route, named by its code and town.
  [/^embarque a ruta\b/, 'out_for_delivery'],
];

/** The stage DYPAQ's own wording gives a movement. */
export function dypaqMappedStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return WORDINGS.get(normalized) ?? PREFIXES.find(([pattern]) => pattern.test(normalized))?.[1];
}

/** A movement's stage: DYPAQ's wording, else the shared rules, else nothing. */
export function dypaqStage(wording: string): ClassifiedWording | null {
  const mapped = dypaqMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  // The tracker gives no codes.
  stage: (code, wording) => (code ? undefined : dypaqMappedStage(wording)),
  gaps: [],
};
