import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * ODM's observations, in Spanish, by how they open: each row goes on with the
 * bus or branch it names, so the whole wording varies from guide to guide. The
 * rows carry no code.
 */
const STAGES: readonly (readonly [RegExp, Stage])[] = [
  // The branch documented the waybill (carta porte) as the sender handed the parcel in at its counter.
  [/^c\.?\s?p\.? documentada\b/, 'accepted'],
  // Put on a bus or a truck towards a branch or distribution centre.
  [/^trasl\. a\b/, 'in_transit'],
  // Unloaded at a branch or distribution centre, which the row names.
  [/^recibida en\b/, 'in_transit'],
  [/^en ruta de reparto\b/, 'out_for_delivery'],
  // The delivery, then the scan of its signed receipt, at the same second.
  [/^c\.?\s?p\.? entregada\b/, 'delivered'],
  [/^entregado\b/, 'delivered'],
];

/** The stage the map gives ODM's wording, if it knows it. */
export function odmStatusStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return STAGES.find(([pattern]) => pattern.test(normalized))?.[1];
}

/**
 * A row's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function odmStage(wording: string): ClassifiedWording | null {
  const mapped = odmStatusStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The rows are wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : odmStatusStage(wording)),
  gaps: [],
};
