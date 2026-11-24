import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** The scan the adapter writes for a record's entry date, the day the item entered the Dominican Republic. */
export const ENTRY = 'Entrada';

/**
 * INPOSDOM's statuses, in Spanish, from its tracker's Estatus column, which
 * carries no code, and the adapter's entry scan.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  [normalizeStatusWording(ENTRY), 'in_transit'],
  // Being processed at INPOSDOM's head office in Santo Domingo; the record names the destination office apart.
  ['procesando en la sede central', 'in_transit'],
]);

/** The stage the map gives a wording, if it knows it. */
export function inposdomStatusStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/**
 * A status's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function inposdomStage(wording: string): ClassifiedWording | null {
  const mapped = inposdomStatusStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The status is wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : inposdomStatusStage(wording)),
  gaps: [],
};
