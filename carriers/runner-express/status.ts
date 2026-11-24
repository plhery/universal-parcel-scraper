import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Runner Express's scans in English, which carry no code: its warehouse at the
 * origin, the flight, customs in Israel, its sorting center and the last-mile
 * partner's delivery, service point and return, as Runner Express words them.
 * Its own receipt at the origin warehouse is the acceptance; the delay waiting
 * for a flight moves on; a parcel waiting at a service point, which the page
 * repeats every few days, is ready for pickup; and the way back from the
 * service point is the return, from its first step.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['shipment information received', 'registered'],
  ['parcel arrive to our warehouse', 'accepted'],
  ['the shenzhen warehouse has been sent out', 'in_transit'],
  ['transport delay, wait for flight.', 'in_transit'],
  ['flight depart', 'in_transit'],
  ['flight arrive at destination airpot', 'in_transit'],
  ['held at clearance facility – declaration submitted', 'customs'],
  ['order received by trucker', 'in_transit'],
  ['customs cleared', 'in_transit'],
  ['arrived to sorting center', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['arrived at service point', 'ready_for_pickup'],
  ['still at service point', 'ready_for_pickup'],
  ['enready to back to sorting center', 'returned'],
  ['on the way back to sorting center', 'returned'],
  ['return to sorting center', 'returned'],
  ['to be returned', 'returned'],
  ['returned to shipper', 'returned'],
]);

/** The stage Runner Express's map gives a wording in `normalizeStatusWording` form. */
export function runnerExpressMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording);
}

/**
 * A scan's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function runnerExpressStage(wording: string): ClassifiedWording | null {
  const mapped = runnerExpressMappedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every wording seen is mapped, whole. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => runnerExpressMappedStage(wording),
  gaps: [],
  wholeWording: true,
};
