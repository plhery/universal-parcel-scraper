import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// The movements the tracker lists for a GC, by their wording: the booking at the origin branch,
// each departure for the next station and arrival there, the delivery run its script looks for,
// and the delivery.
const MOVEMENTS: ReadonlyMap<string, Stage> = new Map([
  ['booking gc', 'accepted'],
  ['out for next station', 'in_transit'],
  ['arrived', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

// The booking's own statuses that the tracker's script shows as delivered: the delivery and the
// steps of filing its proof.
const DELIVERED = new Set(['delivered', 'pod upload/ds completed', 'pod submission done', 'pod submission received',
  'pod submission not received']);

/** The stage of a movement's wording; undefined for one the tracker has not shown. */
export function acplCargoStage(wording: string | null): Stage | undefined {
  return wording ? MOVEMENTS.get(wording.trim().toLowerCase()) : undefined;
}

/** Whether the booking's status is one the tracker shows as delivered. */
export function acplCargoBookingDelivered(status: string): boolean {
  return DELIVERED.has(status.trim().toLowerCase());
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => acplCargoStage(code),
  gaps: [],
};
