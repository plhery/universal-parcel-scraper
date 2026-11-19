import type { CarrierEvent } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Ship Logic's shipment statuses, the vocabulary of the portal Internet Express
 * tracks on. The portal's status list describes each one; codes it lists for
 * quotes, payment and approval come before a booking and are not mapped.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['submitted', 'registered'], // Booked, waiting for a collection driver.
  ['pending-approval', 'registered'],
  ['awaiting-dropoff', 'registered'], // Waiting for the sender to drop it at a locker, kiosk or counter.
  ['collection-assigned', 'registered'],
  // The courier could not collect it from the sender; the parcel still waits for collection.
  ['collection-failed-attempt', 'registered'],
  ['collection-exception', 'exception'], // A problem at collection, such as the address.
  ['collected', 'accepted'],
  ['at-hub', 'in_transit'],
  ['manifested', 'in_transit'], // On a manifest between hubs.
  ['ready-for-dispatch', 'in_transit'],
  ['in-transit', 'in_transit'],
  ['at-destination-hub', 'in_transit'],
  ['delivery-assigned', 'in_transit'],
  ['delivery-scheduled', 'in_transit'],
  ['returned-to-hub', 'in_transit'], // Back at the hub after a failed delivery.
  ['outsourced', 'in_transit'], // Handed to another courier's system for the delivery.
  ['inbound-customs-and-vat', 'customs'],
  ['out-for-delivery', 'out_for_delivery'],
  ['delivery-failed-attempt', 'failed_attempt'],
  ['delivery-exception', 'exception'],
  ['in-locker', 'ready_for_pickup'],
  ['ready-for-pickup', 'ready_for_pickup'],
  ['delivered', 'delivered'],
  ['collected-from-locker', 'delivered'],
  ['collected-from-counter', 'delivered'],
  ['collect-and-return-to-hub', 'returned'], // Taken back from the recipient.
  ['return-to-hub', 'returned'],
  ['returned-to-sender', 'returned'],
  ['undeliverable', 'exception'],
  ['cancelled', 'exception'],
  ['on-hold', 'exception'],
  ['under-query', 'exception'],
  ['damaged', 'exception'],
]);

/** The stage a Ship Logic status code gives a scan. */
export function internetExpressStage(code: string): Stage | undefined {
  return CODES.get(code.toLowerCase());
}

/** The collection codes, which a later leg reuses when its driver takes the parcel from a hub. */
const COLLECTION_CODES: ReadonlySet<string> = new Set(['collection-assigned', 'collection-failed-attempt', 'collected']);
/** Stages that say the courier already has the parcel. */
const HELD_BY_COURIER: ReadonlySet<string> = new Set(['accepted', 'in_transit', 'customs', 'out_for_delivery', 'failed_attempt',
  'ready_for_pickup']);

/**
 * Restages the collection codes a later leg reuses, and gives the stage of the `current` status code. Once the courier
 * has the parcel, a driver collecting it at a hub for the delivery moves it on: the scan reads in transit, not as a
 * parcel waiting for collection or just collected from the sender. `events` is newest first.
 */
export function stageCollectionLegs(events: CarrierEvent[], current: string): Stage | undefined {
  let held = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (held && COLLECTION_CODES.has(event.provider_code ?? '')) events[index] = { ...event, stage: 'in_transit' };
    else if (event.stage && HELD_BY_COURIER.has(event.stage)) held = true;
  }
  const newest = events[0];
  if (newest && current === newest.provider_code) return newest.stage as Stage | undefined;
  return held && COLLECTION_CODES.has(current) ? 'in_transit' : internetExpressStage(current);
}

/** Operational events the portal leaves out of the history it shows. */
export const HIDDEN_CODES: ReadonlySet<string> = new Set(['bob-box-reservation-failed', 'on-hold-internal', 'delivery-rejected',
  'delivery-unassigned', 'collection-rejected', 'collection-unassigned', 'collection-accepted', 'bob-box-dropoff-pin-revealed',
  'operational-event']);

// The portal's own labels for three codes; it writes every other code out in words.
const LABELS: ReadonlyMap<string, string> = new Map([
  ['collection-accepted', 'Collection accepted by driver'],
  ['collection-assigned', 'Collection assigned to driver'],
  ['delivery-assigned', 'Delivery assigned to driver'],
]);

/** A status code as the portal words it: "out-for-delivery" is "Out for delivery". */
export function internetExpressWording(code: string): string {
  const label = LABELS.get(code);
  if (label) return label;
  const words = code.replaceAll('-', ' ').replace(/\bvat\b/g, 'VAT');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? internetExpressStage(code) : undefined),
  gaps: [],
};
