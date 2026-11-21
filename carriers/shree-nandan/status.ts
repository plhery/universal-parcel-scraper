import type { Stage } from '../../core/status/index.js';

/**
 * Travel rows by their action id: 2 is the inward scan worded "Shipment Reached at", 3 the
 * outward one worded "Shipment Forwarded from … To …". Both move the parcel between offices.
 */
const ACTIONS = new Map<string, Stage>([
  ['2', 'in_transit'],
  ['3', 'in_transit'],
]);

/** The words of a delivery record, and of the booking's status, which the tracker shows as the parcel's status. */
const STATUSES = new Map<string, Stage>([
  ['delivered', 'delivered'],
]);

export function travelStage(action: string): Stage | undefined {
  return ACTIONS.get(action);
}

export function statusStage(wording: string): Stage | undefined {
  return STATUSES.get(wording.trim().toLowerCase());
}

/** The booking, which the adapter words "Booked": the booking office has taken the parcel in. */
export const BOOKED_STAGE: Stage = 'accepted';
