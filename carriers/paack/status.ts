/**
 * Paack event identifiers → product stage.
 *
 * The recipient page ships a timeline whose entries carry a stable `id` and a
 * translation `label`; the visible text is localized per viewer, so the map
 * keys on the identifiers instead. Both fields are reduced to lower-case
 * letters and digits and concatenated, then matched by substring, which keeps
 * suffixed variants ("scannedAtOriginHeader", "pudoAssignedHeader") on the
 * same stage as their base identifier.
 *
 * Order matters: return and failure identifiers are tested before the broader
 * delivery ones, so "notDelivered" can never match the "delivered" substring.
 * PaackGo Point identifiers come from the page's own vocabulary and are tested
 * before the generic words they contain: "rejectedByPudo" is a retried
 * delivery, not a rejection, and "collectedByCustomer" is the recipient
 * collecting the parcel, not a transit collection.
 * The provider's own wording is never returned; each mapped entry supplies the
 * English description we display.
 *
 * Aggregators relay the English text of Paack's timeline instead of its
 * identifiers. `paackScan` maps those labels exactly, never by substring, and
 * stores the same description as the direct lookup so both copies of a scan
 * read alike.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import type { Stage } from '../../generated/catalog.js';
import type { JsonObject } from '../../core/types.js';

export interface ClassifiedPaackStatus {
  status: CarrierStatus;
  stage: Stage;
  description: string;
}

/** Reduce a provider identifier or label to lower-case letters and digits. */
export function statusKey(value: unknown): string {
  return typeof value === 'string'
    ? value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '')
    : '';
}

function includesAny(value: string, candidates: string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

const REGISTERED: ClassifiedPaackStatus = { status: 'pending', stage: 'registered', description: 'Shipment registered' };
const ACCEPTED: ClassifiedPaackStatus = { status: 'in_transit', stage: 'accepted', description: 'Shipment accepted' };
const OUT_FOR_DELIVERY: ClassifiedPaackStatus = {
  status: 'out_for_delivery',
  stage: 'out_for_delivery',
  description: 'Out for delivery',
};
const DELIVERED: ClassifiedPaackStatus = { status: 'delivered', stage: 'delivered', description: 'Delivered' };
const DELIVERY_ISSUE: ClassifiedPaackStatus = { status: 'exception', stage: 'failed_attempt', description: 'Delivery issue' };

/** Paack's English timeline labels, keyed like `statusKey`, with the identifier each one renders. */
const RELAYED = new Map<string, ClassifiedPaackStatus>([
  ['orderdetailsreceived', REGISTERED], // manifested
  ['inpaacksdistributioncentre', ACCEPTED], // scannedAtOrigin
  ['outfordelivery', OUT_FOR_DELIVERY], // inDelivery
  ['delivered', DELIVERED], // delivered
]);

/** The stage and stored wording of a Paack timeline label an aggregator relays. */
export function paackScan(label: string): { stage: Stage; wording: string } | undefined {
  const entry = RELAYED.get(statusKey(label));
  return entry && { stage: entry.stage, wording: entry.description };
}

export function classifyPaackEvent(value: JsonObject): ClassifiedPaackStatus {
  const key = `${statusKey(value.label)} ${statusKey(value.id)}`;
  if (includesAny(key, [
    'returnedsender',
    'returnedtosender',
    'returnedtoretailer',
  ])) {
    return { status: 'exception', stage: 'returned', description: 'Shipment returned' };
  }
  // Expired, refused or unpaid at the PaackGo Point: on its way back to the retailer.
  if (includesAny(key, [
    'inpudotoreturnexpired',
    'inpudotoreturnrejected',
    'inpudotoreturncodnotaccepted',
  ])) {
    return { status: 'exception', stage: 'returned', description: 'Returning to sender' };
  }
  // The point was closed, full or refused the parcel; Paack tries again.
  if (includesAny(key, ['pudoclosed', 'pudofull', 'rejectedbypudo'])) {
    return { ...DELIVERY_ISSUE };
  }
  if (includesAny(key, [
    'incorrectaddress',
    'notaccepted',
    'rejected',
    'damaged',
    'lost',
    'nondeliverable',
    'integrationerror',
    'cancelled',
    'canceled',
  ])) return { status: 'exception', stage: 'exception', description: 'Shipment exception' };
  if (includesAny(key, [
    'returntosenderscheduled',
    'returnabsent',
    'returnother',
    'absent',
    'attempted',
    'deliveryfailed',
    'failedattempt',
    'notdelivered',
    'undelivered',
  ])) return { ...DELIVERY_ISSUE };
  if (includesAny(key, ['delivered', 'deliverycompleted', 'collectedbycustomer'])) return { ...DELIVERED };
  if (includesAny(key, ['droppedinpudo'])) {
    return { status: 'out_for_delivery', stage: 'ready_for_pickup', description: 'Ready for pickup' };
  }
  if (includesAny(key, ['outfordelivery', 'indelivery', 'driverassigned', 'inprogress'])) return { ...OUT_FOR_DELIVERY };
  if (includesAny(key, [
    'manifested',
    'created',
    'notreceivedfromretailer',
    'additionaldeliveryattemptscheduled',
    'orderreactivated',
    'appointmentbroughtforward',
    'appointmentrescheduled',
    'appointmentscheduled',
  ])) return { ...REGISTERED };
  if (includesAny(key, ['scannedatorigin'])) return { ...ACCEPTED };
  if (includesAny(key, [
    'received',
    'collected',
    'transit',
    'hub',
    'warehouse',
    'sorted',
    'pudoassigned',
  ])) {
    return { status: 'in_transit', stage: 'in_transit', description: 'In transit' };
  }
  return { status: 'unknown', stage: 'in_transit', description: 'Shipment update' };
}
