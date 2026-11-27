import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { dispatchTrackCodeStage } from '../high-energy-transport/status.js';

/**
 * Ryder Last Mile's order events, worded as a status, a hyphen and the
 * details ("Order Delivered-Shipment Delivered on ..."). The map reads the
 * status. The snapshot's stage codes are DispatchTrack's.
 */
const EVENTS: ReadonlyMap<string, Stage> = new Map([
  // Left the origin hub for the delivery hub.
  ['order departed', 'in_transit'],
  ['order received at delivery location', 'in_transit'],
  ['order enroute to customer', 'out_for_delivery'],
  ['order delivered', 'delivered'],
]);
// Calls and messages about the delivery appointment, which leave the order where it was.
const NOTICE = 'A notice about the delivery appointment; the order stays where the event before it left it.';
const NOTICES: ReadonlySet<string> = new Set([
  'scheduling call', 'delivery scheduled', 'time window set', 'time window notification attempted',
]);

/** An event's status: its wording before the details. */
function heading(wording: string): string {
  return normalizeStatusWording(wording).split('-')[0]!.trim();
}

/** The stage the map gives an event's wording, if it knows it. */
export function ryderMappedStage(wording: string): Stage | undefined {
  return EVENTS.get(heading(wording));
}

/** An event's stage: the map, none for an appointment notice, else the shared wording rules. */
export function ryderEventStage(wording: string): ClassifiedWording | null {
  const mapped = ryderMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (NOTICES.has(heading(wording))) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about a snapshot's stage code or an event's wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? dispatchTrackCodeStage(code) : ryderMappedStage(wording)),
  gaps: [],
  gapNote: (code, wording) => (!code && NOTICES.has(heading(wording)) ? NOTICE : undefined),
};
