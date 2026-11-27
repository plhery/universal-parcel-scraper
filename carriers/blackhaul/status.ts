import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Wordings of Transvirtual, the consignment software behind Blackhaul's
 * tracker, which come without codes: those VT Freight Express's and Hunter
 * Express's trackers show, and the delivery statuses Transvirtual documents.
 * Another falls to the shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  [normalizeStatusWording('Pickup Completed'), 'accepted'],
  [normalizeStatusWording('Depot In'), 'in_transit'],
  [normalizeStatusWording('In Depot'), 'in_transit'],
  // Kept at the depot for the next run.
  [normalizeStatusWording('Held For Processing'), 'in_transit'],
  [normalizeStatusWording('Linehaul Out'), 'in_transit'],
  [normalizeStatusWording('On Delivery'), 'out_for_delivery'],
  // The status above the history once the van has left the depot.
  [normalizeStatusWording('OnDelivery, Left Depot'), 'out_for_delivery'],
  [normalizeStatusWording('Mobile - Card Left'), 'failed_attempt'],
  [normalizeStatusWording('Mobile - Location Closed'), 'failed_attempt'],
  // Back to the depot after the receiver's place was closed.
  [normalizeStatusWording('Returning Depot - Location Closed'), 'failed_attempt'],
  [normalizeStatusWording('Delivered'), 'delivered'],
]);

/** The stage Blackhaul's map gives a wording in `normalizeStatusWording` form. */
export function blackhaulMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording);
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function blackhaulStage(wording: string): ClassifiedWording | null {
  const mapped = blackhaulMappedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every wording recorded is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => blackhaulMappedStage(wording),
  gaps: [],
};
