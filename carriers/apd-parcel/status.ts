import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// The tracking page's script names six actions and puts five of them on its summary: picked
// up, in depot, out for delivery (a driver's `accept`, else a transshipment), an attempted
// delivery and the delivery.
const ACTIONS: ReadonlyMap<string, { stage: Stage; wording: string }> = new Map([
  ['pickup', { stage: 'accepted', wording: 'Picked Up' }],
  ['indepot', { stage: 'in_transit', wording: 'Arrived In Depot' }],
  // Handed to another carrier: the summary shows it as out for delivery only when no driver loaded the parcel.
  ['carriermanifest', { stage: 'in_transit', wording: 'Transshipped' }],
  ['accept', { stage: 'out_for_delivery', wording: 'Loaded for Delivery' }],
  ['failed', { stage: 'failed_attempt', wording: 'Attempted Delivery' }],
  ['deliver', { stage: 'delivered', wording: 'Delivered' }],
]);

/** The stage of one of the script's actions; undefined for an action it does not name. */
export function apdStage(action: string | null): Stage | undefined {
  return action ? ACTIONS.get(action)?.stage : undefined;
}

/** The page's wording for an action, else the action's own description. */
export function apdWording(action: string, description: string): string {
  return ACTIONS.get(action)?.wording ?? description;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => apdStage(code),
  gaps: [],
};
