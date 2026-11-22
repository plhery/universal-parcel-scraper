import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Courier IT's event names. Its tracker names a detail after a dash, such as
 * who signed or which route took the parcel, so the name is what comes before.
 * Waybill details are captured after Courier IT takes the parcel, and a parcel
 * that comes back from a round is handed to the branch's cage.
 */
const NAMES: ReadonlyMap<string, Stage> = new Map([
  ['handed over', 'accepted'],
  ['collected', 'accepted'],
  ['captured ops', 'registered'],
  ['depot checkin', 'in_transit'],
  ['depot checkout', 'in_transit'],
  ['accepted at branch', 'in_transit'],
  ['parcel handover (cage)', 'in_transit'],
  ['loaded into vehicle', 'out_for_delivery'],
  ['delivery exception (manual)', 'failed_attempt'],
  ['delivery details', 'delivered'],
  ['text pod', 'delivered'],
  ['proof of delivery', 'delivered'],
  ['pod rec. in branch', 'delivered'],
]);

/** The event name of a description: what comes before its detail. */
export function courierItEventName(description: string): string {
  return description.split(/\s+-(?:\s|$)/)[0]!.trim();
}

/** The stage the map gives an event, if it knows its name. */
export function courierItStage(description: string): Stage | undefined {
  return NAMES.get(normalizeStatusWording(courierItEventName(description)));
}

/** The events carry no code; the event name sets the stage. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : courierItStage(wording)),
  gaps: [
    { wording: 'collection booked', note: 'A collection booked for the parcel, at the time of its handover; it does not move it.' },
    { wording: 'courier pick-up number', note: 'The collection\'s reference, given at the handover; it does not move the parcel.' },
  ],
  wholeWording: true,
};
