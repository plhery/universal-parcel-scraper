import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

// The tracker's states, as its replies word them along a guía's way between branches.
// "Ocurre" is the branch where the addressee collects the parcel.
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['documentada', 'accepted'],
  ['embarcada', 'in_transit'],
  ['en tráfico', 'in_transit'],
  ['trasbordo', 'in_transit'],
  ['desembarcada', 'in_transit'],
  ['en ocurre', 'ready_for_pickup'],
  ['entregada', 'delivered'],
]);

/** The stage of a state the tracker names, or undefined for one no reply has shown yet. */
export function flechaStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => flechaStage(wording),
  gaps: [],
  wholeWording: true,
};

/** A scan's stage: the map, else the shared wording rules, else none. */
export function scanStage(wording: string): ClassifiedWording | null {
  const mapped = flechaStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}
