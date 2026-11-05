/**
 * USPS status vocabulary.
 *
 * The tracking page renders English prose (the status banner and the history
 * rows) with no stable per-event code, so wording is matched on substrings.
 * The map produces a result-level `CarrierStatus` and, when the wording is
 * recognized, the event `Stage`.
 *
 * Wording provenance: the official Tracking API vocabulary and its published
 * examples (DELIVERED, OUT FOR DELIVERY, IN TRANSIT, PRE-SHIPMENT, ALERT,
 * NOTICE LEFT, ARRIVED, DEPARTED, ACCEPTED, PICKED UP — prior art).
 * `statuses.json` holds the full list.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import { trackingLanguageStage, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// USPS's "Refused" is the addressee refusing the item, which USPS returns to the sender.
const RETURNED_TERMS = ['return to sender', 'returned to sender', 'returning to sender', 'refused'];
// An address the carrier could not deliver to ("Insufficient Address", "No Such Number") ends the round;
// the item can go out again once the address is resolved.
const FAILED_ATTEMPT_TERMS = [
  'delivery attempted', 'delivery attempt', 'notice left', 'no access',
  'receptacle blocked', 'business closed', 'no secure location', 'no authorized recipient',
  'missed delivery', 'redelivery', 'unclaimed', 'vacant', 'no such number', 'insufficient address',
];
const EXCEPTION_TERMS = ['alert', 'exception', 'damaged', 'lost', 'seized', 'dispute', 'held for pickup'];
const DELIVERED_TERMS = ['delivered'];
const OUT_FOR_DELIVERY_TERMS = ['out for delivery'];
// The delivering post office's arrival ("Arrived at Post Office") comes before the delivery round, so it is transit;
// a parcel waits there for its recipient only once it is held.
const READY_FOR_PICKUP_TERMS = ['available for pickup', 'available for pick-up', 'pickup', 'pick up', 'held at post office'];
// A label printed at the counter is dated by its day alone; the item's acceptance is the scan of it that follows.
const REGISTERED_TERMS = [
  'pre-shipment', 'preshipment', 'shipping label created', 'label created', 'shipping label printed',
  'acceptance pending', 'usps awaiting item', 'awaiting item', 'order received', 'origin post is preparing',
];
// A facility arrival ("Arrived at USPS Facility") follows acceptance: it is transit. Incoming
// international mail shows the origin post's posting as "Acceptance", and a Post Office counter
// its receipt for an item handed in as "USPS electronic receipt of item for mailing".
const ACCEPTED_TERMS = [
  'accepted', 'acceptance', 'in possession of item', 'receipt of item for mailing', 'picked up', 'picked-up', 'tendered',
  'shipment received',
];
const CUSTOMS_TERMS = ['customs', 'clearance'];
// "Awaiting Delivery (Scan)" ends a delivery day without a delivery scan, at about 9 pm local time; USPS then
// expects the delivery the next business day.
const IN_TRANSIT_TERMS = [
  'awaiting delivery', 'in transit', 'on its way', 'in-transit', 'arrived', 'departed', 'departure',
  'arrival', 'processed', 'processing', 'distribution center', 'sorting facility',
  'en route', 'in route', 'forwarded', 'transferred', 'tendered to', 'dispatch',
];

/**
 * Classify USPS status prose. Returns null when nothing matches, so callers
 * leave an event unstaged rather than invent a stage. `hasEvents` reports an
 * existing history, which makes unrecognized wording "moving" rather than
 * "unknown" at the result level.
 */
export function uspsStage(text: string): Stage | null {
  const value = text.toLocaleLowerCase('en-US');
  if (!value) return null;
  if (RETURNED_TERMS.some((term) => value.includes(term))) return 'returned';
  if (FAILED_ATTEMPT_TERMS.some((term) => value.includes(term))) return 'failed_attempt';
  if (DELIVERED_TERMS.some((term) => value.includes(term))) return 'delivered';
  if (OUT_FOR_DELIVERY_TERMS.some((term) => value.includes(term))) return 'out_for_delivery';
  if (READY_FOR_PICKUP_TERMS.some((term) => value.includes(term))) return 'ready_for_pickup';
  // A customs line the shared rules read as cleared ("Cleared customs") is a step in transit.
  if (CUSTOMS_TERMS.some((term) => value.includes(term))) return trackingLanguageStage(text) === 'in_transit' ? 'in_transit' : 'customs';
  if (EXCEPTION_TERMS.some((term) => value.includes(term))) return 'exception';
  if (REGISTERED_TERMS.some((term) => value.includes(term))) return 'registered';
  if (ACCEPTED_TERMS.some((term) => value.includes(term))) return 'accepted';
  if (IN_TRANSIT_TERMS.some((term) => value.includes(term))) return 'in_transit';
  return null;
}

export function statusForStage(stage: Stage): CarrierStatus {
  if (stage === 'delivered') return 'delivered';
  if (stage === 'out_for_delivery' || stage === 'ready_for_pickup') return 'out_for_delivery';
  if (stage === 'exception' || stage === 'failed_attempt' || stage === 'returned') return 'exception';
  if (stage === 'registered' || stage === 'pending') return 'pending';
  return 'in_transit';
}

/** The result-level status for banner and history wording. */
export function uspsStatus(text: string, hasEvents = false): CarrierStatus {
  const stage = uspsStage(text);
  if (stage) return statusForStage(stage);
  // Unrecognized wording only means "moving" once the shipment has scans.
  return hasEvents ? 'in_transit' : 'unknown';
}

/** What the map says about one scan: USPS's scans carry no code, and their wording alone stages them. */
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => uspsStage(wording) ?? undefined, gaps: [] };
