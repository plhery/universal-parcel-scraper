import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * SEKO's shipment statuses, in `normalizeStatusWording` form. A milestone
 * names the one it moved to as "Status Changed to [At Pickup Terminal]".
 * SEKO's tracking page files them under five steps; the vendor's list of
 * those steps names most of them.
 */
const STATUSES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['shipment data received', 'registered'],
  ['shipment being processed for pickup', 'registered'],
  // The driver reached the shipper; the freight is not on board yet.
  ['arrived at pu location', 'registered'],
  ['picked up from customer', 'accepted'],
  ['at pickup terminal', 'accepted'],
  ['in transit', 'in_transit'],
  ['in transit- confirmed out of origin', 'in_transit'],
  ['in transit to delivery terminal', 'in_transit'],
  ['at transfer terminal', 'in_transit'],
  ['at delivery terminal', 'in_transit'],
  ['at delivery terminal delivery appt set', 'in_transit'],
  ['on hand dest delv appt set', 'in_transit'],
  ['on hand destination station', 'in_transit'],
  // Into SEKO's warehouse at destination, the step before delivery on the page.
  ['delivered to warehouse', 'in_transit'],
  ['temporary origin hold', 'exception'],
  ['temporary destination hold', 'exception'],
  ['out for delivery', 'out_for_delivery'],
  ['shipment is out for delivery', 'out_for_delivery'],
  // The driver at the delivery address, minutes before the delivery.
  ['driver on site delivery location', 'out_for_delivery'],
  ['delivered', 'delivered'],
  ['shipment delivered', 'delivered'],
]);

/** Milestones in SEKO's own words that name no status. */
const MESSAGES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['shipment created', 'registered'],
  ['shipment information received', 'registered'],
  ['shipment in transit to delivery station.', 'in_transit'],
]);

/**
 * OmniParcel's statuses, which its tracker shows without their codes: the wordings of SEKO's
 * OmniParcel code list and API example, and the lines its tracker was seen to show.
 */
const OMNIPARCEL: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['tracking number allocated & order ready', 'registered'],
  ['received at origin warehouse - received at warehouse', 'accepted'],
  ['processed through export hub', 'in_transit'],
  ['flight - freight departed to destination', 'in_transit'],
  ['international transit to destination country', 'in_transit'],
  ['received by destination customs', 'customs'],
  ['customs held for inspection and clearance', 'customs'],
  ['customs cleared', 'in_transit'],
  // The destination's hub taking the parcel after customs, long after the journey started.
  ['parcel received and accepted', 'in_transit'],
  ['received by carrier', 'in_transit'],
  ['received by last mile provider', 'in_transit'],
  // The last-mile courier's hub, named in the line, the evening before its round.
  ['the order has arrived at the … sorting hub.', 'in_transit'],
  // The last-mile courier's line, hours before its delivery.
  ['the order is on the way to the recipient.', 'out_for_delivery'],
  ['customer to collect from carrier', 'ready_for_pickup'],
  ['awaiting collection', 'ready_for_pickup'],
  ['delivered to locker/collection point', 'ready_for_pickup'],
  ['attempted delivery', 'failed_attempt'],
  ['attempted delivery - refused by customer', 'failed_attempt'],
  ['return to sender', 'returned'],
  ['delivered - authority to leave / safe drop', 'delivered'],
]);

// The last-mile courier's hub line names the hub: "The order has arrived at the Example sorting hub."
const SORTING_HUB = /^(the order has arrived at the ).{1,60}?( sorting hub)\.?$/;

// "Status Changed to [X]", with the brackets or, for one status, a trailing dash instead.
const CHANGED = /^status changed to\s*(.*)$/;

// A return booked for the shipment; the page counts it as a finished journey, but nothing went back yet.
const RETURN_DATA = 'return data received';

/** The status a wording names: the summary's own, or the one a milestone changed to. */
function statusOf(normalized: string): string {
  const changed = CHANGED.exec(normalized)?.[1] ?? normalized;
  return changed.replace(/^\[\s*|\s*\]$/g, '').replace(/[\s-]+$/, '');
}

/** Proof-of-delivery bookkeeping, recorded after the delivery: it moves nothing, and the adapter drops it. */
export function isSekoBookkeeping(wording: string): boolean {
  return /^pod imag(?:ed|e attached)$/.test(normalizeStatusWording(wording));
}

/** The stage SEKO's own vocabulary gives a status or milestone, on its tracking page or OmniParcel's. */
export function sekoMappedStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return MESSAGES.get(normalized) ?? OMNIPARCEL.get(normalized.replace(SORTING_HUB, '$1…$2.'))
    ?? STATUSES.get(statusOf(normalized));
}

/** A milestone's stage: SEKO's vocabulary, else the shared wording rules, else nothing. */
export function sekoStage(wording: string): ClassifiedWording | null {
  const mapped = sekoMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (isSekoBookkeeping(wording) || statusOf(normalizeStatusWording(wording)) === RETURN_DATA) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  // Neither tracker gives codes; the coded entries in statuses.json are from OmniParcel's code list.
  stage: (code, wording) => (code ? undefined : sekoMappedStage(wording)),
  gaps: [
    { wording: 'pod image attached', note: 'The proof of delivery\'s picture filed after the delivery; it moves nothing.' },
    { wording: 'pod imaged', note: 'The proof of delivery filed, sometimes days after the delivery; it moves nothing.' },
    { wording: RETURN_DATA, note: 'A return booked for the shipment, which says nothing of where the freight is.' },
    { wording: `status changed to [${RETURN_DATA}]`, note: 'A return booked for the shipment, which says nothing of where the freight is.' },
  ],
};
