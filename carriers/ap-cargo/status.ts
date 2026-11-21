import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's rows carry a short status without a code. Those seen in its
 * replies are mapped, and so are the former tracker's, which providers may
 * still relay; an arrival or an acceptance names its place. Other wording
 * falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Successfully Accepted', 'accepted'],
  ['Accepted', 'accepted'],
  ['In-Transit', 'in_transit'],
  ['In Transit', 'in_transit'],
  ['In-Transit (Transferred to Branch)', 'in_transit'],
  ['In Transit to Destination Branch', 'in_transit'],
  ['Arrived', 'in_transit'],
  ['Out for Delivery', 'out_for_delivery'],
  // The consignee took the cargo: the older tracker reports the same parcel delivered that day.
  ['Received', 'delivered'],
  ['Delivered', 'delivered'],
  // Collected at the destination branch.
  ['Claimed', 'delivered'],
  // The former tracker's undelivered slot: the delivery failed and the cargo goes back to the branch.
  ['Return upon Delivery', 'failed_attempt'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
const ACCEPTANCE = /^accepted at \S/;
const ARRIVAL = /^arrived at \S/;

/** The stage the map gives a row's wording. */
export function apCargoMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return WORDINGS.get(key) ?? (ACCEPTANCE.test(key) ? 'accepted' : ARRIVAL.test(key) ? 'in_transit' : undefined);
}

/** A row's stage: its wording in the map, else the shared wording rules, else nothing. */
export function apCargoStage(wording: string): ClassifiedWording | null {
  const mapped = apCargoMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => apCargoMappedStage(wording),
  gaps: [],
};
