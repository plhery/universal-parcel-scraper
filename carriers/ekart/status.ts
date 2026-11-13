import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// Ekart words a scan as prose ("Shipment Created", "Received at ExampleHub")
// or as an operational code followed by its hub ("InscannedAtDH - ExampleHub").
const STAGES = new Map<string, Stage>(Object.entries({
  pickuprequested: 'registered', shipmentcreated: 'registered',
  // A pickup run, or one that failed, leaves the parcel with the seller.
  outforpickupevent: 'registered', notpickedevent: 'registered',
  pickupfromseller: 'accepted', pickupreceived: 'accepted',
  shipmentgrouped: 'in_transit', shipmentintransit: 'in_transit', dispatchedtotc: 'in_transit', dispatched: 'in_transit',
  // "Expected" announces the parcel at the hub it is travelling to.
  expected: 'in_transit', received: 'in_transit', inscannedatfacility: 'in_transit',
  inscannedatdh: 'in_transit', primarydhinscan: 'in_transit',
  outfordelivery: 'out_for_delivery', delivered: 'delivered',
  undeliveredattempted: 'failed_attempt', undeliveredunattempted: 'failed_attempt',
  // The attempt's code beside its hub, and the update Ekart writes with it at the same instant.
  shipmentundeliveredattempted: 'failed_attempt', undeliveredupdate: 'failed_attempt',
  pickupcancel: 'exception', shipmentrtoconfirmed: 'exception',
  rtoexpected: 'in_transit', rtoreceived: 'in_transit', returninscanned: 'in_transit',
} satisfies Record<string, Stage>));

const key = (text: string) => text.toLowerCase().replace(/[^a-z]/g, '');

// A delivery round's outcome in prose ("Unsuccessful Undelivered. (Rescheduled to: …)"). A pickup run's leaves the
// parcel with the seller: registered, as the pickup request before it.
const UNSUCCESSFUL = /^unsuccessful\s+(?!.*\bpick ?up\b)\S/i;
const UNSUCCESSFUL_PICKUP = /^unsuccessful\s+.*\bpick ?up\b/i;
// "Marked RTO" and its reason in prose ("Marked RTO: ORDER_REJECT"): the return to the seller starts, as ShipmentRtoConfirmed.
const MARKED_RTO = /^marked rto\b/i;

/** The code of a code-shaped scan, its mapped stage, and whether it starts or continues a return. */
export function ekartScan(description: string): { code?: string; stage?: Stage; returning: boolean } {
  const coded = /^([A-Za-z]+(?:_[A-Za-z]+)*) - \S/.exec(description);
  const code = coded?.[1];
  // A hub's name after "Received at" or "Dispatched to": the parcel arriving there, or sent on to it.
  // "Unsuccessful" and its reason in prose: the round out for delivery ended without delivering.
  const stage = code ? STAGES.get(key(code)) : /^(?:received at|dispatched to) \S/i.test(description) ? 'in_transit'
    : UNSUCCESSFUL.test(description) ? 'failed_attempt' : UNSUCCESSFUL_PICKUP.test(description) ? 'registered'
    : MARKED_RTO.test(description) ? 'exception' : STAGES.get(key(description));
  const returning = code ? /^(?:rto|return|shipmentrto)/i.test(code) : MARKED_RTO.test(description);
  return { ...(code ? { code } : {}), ...(stage ? { stage } : {}), returning };
}

/**
 * What the map says about one scan: its wording, prose or a code before its hub, as the adapter
 * reads it. A delivery after an RTO scan reaches the seller, and the stored scan does not keep
 * the scans before it, so it stays open.
 */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => {
    const { stage } = ekartScan(wording);
    return stage === 'delivered' ? undefined : stage;
  },
  gaps: [{ wording: 'delivered', note: 'Delivered to the recipient, or back to the seller once an earlier RTO scan started the return leg: the stored scan does not keep the scans before it.' }],
};
