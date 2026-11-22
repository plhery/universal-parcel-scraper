import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { courierItStage } from '../courier-it/status.js';

/**
 * The event names PostNet's tracker shows for its waybills. Its own events
 * name the PostNet in brackets after the event. A waybill is created at the
 * PostNet the sender hands the parcel in at. Older waybills show Courier IT's
 * events, which its map reads.
 */
const NAMES: ReadonlyMap<string, Stage> = new Map([
  ['shipment created', 'accepted'],
  ['ready for collection', 'ready_for_pickup'],
  ['customer collection', 'delivered'],
]);

/** The event name of a description: what comes before its bracketed detail. */
export function postNetEventName(description: string): string {
  return description.replace(/\s*\(.*\)\s*$/, '');
}

/** The stage the map gives an event name, if it knows it. */
export function postNetStage(name: string): Stage | undefined {
  return NAMES.get(normalizeStatusWording(postNetEventName(name))) ?? courierItStage(name);
}

/** The events carry no code; the event name sets the stage. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : postNetStage(wording)),
  gaps: [],
};
