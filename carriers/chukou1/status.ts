import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { chinaPostRelayedStage } from '../china-post/status.js';

/**
 * Chukou1's own scan wordings, as its first leg writes them after the place,
 * with the descriptions of the scan codes its open API lists. Scans carry no
 * code. China Post's are read as China Post's relayed scans; another partner's
 * wording is left to the shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['shipment information received', 'registered'], // The seller's order reached Chukou1.
  ['carrier received the manifest', 'registered'],
  ['item received by logistics centre', 'accepted'], // At Chukou1's sorting centre in China.
  ['carrier received the shipment', 'accepted'],
  ['item was sent out from logistics centre', 'in_transit'],
  ['shipment arrived at a carrier facility', 'in_transit'],
  ['shipment departed from a carrier facility', 'in_transit'],
  ['transfer to airport of origin', 'in_transit'],
  ['arrived at airport of origin', 'in_transit'],
  ['departed from airport of origin', 'in_transit'],
  // Export clearance started, or finished as its code says: a routine step before the flight, not a hold.
  ['shipment started the customs clearance process at origin', 'in_transit'],
  ['arrived at airport of destination', 'in_transit'],
  ['shipment arrived in the destination country', 'in_transit'],
  ['customs clearance in progress', 'customs'],
  ['shipment started the customs clearance process at destination', 'customs'],
  ['shipment is awaiting customs clearance at destination', 'customs'],
  // Cleared at destination: the parcel moves on.
  ['customs declaration completed', 'in_transit'],
  ['shipment completed the customs clearance process at destination', 'in_transit'],
  ['transport to next facility', 'in_transit'],
  ['turned over to last mile facility', 'in_transit'], // Handed to the destination carrier.
  ['last mile ascan', 'in_transit'], // The destination carrier's first scan.
  ['arrived at post office', 'in_transit'],
  ['the instruction data for this shipment have been provided by the sender to dhl electronically.', 'registered'],
  ['the shipment is in transit to dhl', 'in_transit'],
  ['in transit', 'in_transit'],
  ['shipment is out for delivery', 'out_for_delivery'],
  ['wrong address', 'failed_attempt'],
  ['refused', 'failed_attempt'],
  ['cannot be delivered', 'failed_attempt'],
  ['shipment is available for pickup', 'ready_for_pickup'],
  ['shipment delivered to customer', 'delivered'],
  ['return to sender', 'returned'],
  ['delivered to sender', 'returned'],
  ['lost', 'exception'],
]);

/**
 * The shipment's own status, which the page heads it with. `InProcess` is a
 * parcel still at Chukou1's warehouses or on its first leg; `NotFound` is not
 * a parcel.
 */
const SUMMARIES: ReadonlyMap<string, Stage> = new Map([
  ['InProcess', 'in_transit'],
  ['InTransit', 'in_transit'],
  ['Delivered', 'delivered'],
]);

// China Post's scans in its feed, kept whole after the place ("<town>, 航空公司启运"), read as China Post's scans
// relayed in Chinese are. Its receipt keeps a space after its name: "中国邮政 已收取邮件".
const chinaPostStage = (wording: string): Stage | undefined => chinaPostRelayedStage(wording.slice(wording.lastIndexOf(',') + 1)
  .trim().replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, ''));

/** The stage Chukou1's wordings give a scan, or China Post's in its feed, if the map knows it. */
export function chukou1MappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording.toLocaleLowerCase('en-US').trim().split(/\s+/).join(' ')) ?? chinaPostStage(wording);
}

/** The stage of a shipment's own status, if the page shows one. */
export function chukou1SummaryStage(status: string): Stage | undefined {
  return SUMMARIES.get(status);
}

/** A scan's stage: Chukou1's wordings, else the shared wording rules, else nothing. */
export function chukou1Stage(wording: string): ClassifiedWording | null {
  const mapped = chukou1MappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one scan, by its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : chukou1MappedStage(wording)),
  gaps: [],
};
