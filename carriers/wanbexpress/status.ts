import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, SHARED_WORDINGS, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { imileMappedStage } from '../imile/status.js';

const STAGES: Readonly<Record<string, Stage>> = {
  DataReceived: 'registered', SupplierDataReceived: 'registered', OriginalWarehouseReceive: 'accepted',
  OriginalWarehouseProcess: 'in_transit', OriginalWarehouseDeparture: 'in_transit',
  LinehaulAgencyReceive: 'in_transit', LinehaulAgencyDeparture: 'in_transit', LinehaulDeparture: 'in_transit',
  // The origin's export inspection, between the line-haul agent's customs declaration and its departure: the journey
  // goes on at origin, as other export clearances read, not the destination's customs.
  CustomsArrival: 'in_transit',
  LinehaulArrival: 'in_transit', CustomsCleared: 'in_transit', SupplierAndLastMileReceive: 'in_transit',
  LastMileWarehouseReceive: 'in_transit', LastMileInTransit: 'in_transit', LastMileOutForDelivery: 'out_for_delivery', LastMileDeliveryReady: 'out_for_delivery',
  LastMileDeliveryFailed: 'failed_attempt', LastMileDeliveryTried: 'failed_attempt', LastMileWaitForCollection: 'ready_for_pickup',
  LastMileDelivered: 'delivered',
};

// The last-mile partners' scans relayed without a code, by `normalizeStatusWording` wording: a US
// partner's between its receipt and the delivery run, DHL's in Germany and InPost's in the UK.
// Null marks a line that moves nothing.
const UNCODED: ReadonlyMap<string, Stage | null> = new Map<string, Stage | null>([
  ['in processing at transit facility.', 'in_transit'],
  // An acceptance scan relayed between the sorting centre's processing and its departure: the journey goes on.
  ['a-scan: shipment in international transit', 'in_transit'],
  // A US partner's departure from its destination hub, before its warehouse receives the parcel (LastMileWarehouseReceive).
  ['departed destination hub', 'in_transit'],
  // The same partner's departure from its facility and its local facility's receipt before the delivery run.
  ['parcel departed from facility.', 'in_transit'],
  ['parcel received by local facility.', 'in_transit'],
  ['parcel received by transit facility.', 'in_transit'],
  ['in transit to next facility.', 'in_transit'],
  ['in transit to next facility', 'in_transit'],
  // SpeedX's way to the delivering facility and its arrival there, at the same second as its lines coded 57112 and 57101.
  ['in transit to destination facility', 'in_transit'],
  ['arrival at destination facility', 'in_transit'],
  // USPS's notice of a parcel still moving but behind its expected day.
  ['in transit, arriving late', 'in_transit'],
  ['it is currently in transit to the next facility', 'in_transit'],
  ['the package is being transferred to the next facility', 'in_transit'],
  ['the shipment has been processed in the parcel center of origin', 'in_transit'],
  ['the shipment arrived in the region of recipient and will be transported to the delivery base in the next step.', 'in_transit'],
  // Held at the delivery base for another day: no round, so no attempt.
  ['the shipment has been postponed and will probably be delivered on the next working day', 'in_transit'],
  ['the shipment has been loaded onto the delivery vehicle. delivery is expected to take place today.', 'out_for_delivery'],
  // The same loading in WanbExpress's shorter English, at the second of DHL's German line for it.
  ['the shipment has been loaded onto the delivery vehicle.', 'out_for_delivery'],
  // WanbExpress's English at the second of DHL's German line that the branch holds the parcel from the next working
  // day, after a missed delivery: that line stages it, and this one, worded as a round, moves nothing.
  ['being delivered.', null],
  // After the sorting centre's departure, before the partner that delivers it takes the parcel.
  ['parcel is ready for hand over to distributor', 'in_transit'],
  // A partner's pre-advice, at the instant WanbExpress records the parcel's data, before its sorting centre has it.
  ["order information received. we're expecting your parcel to arrive with us.", 'registered'],
  // InPost's lines on a parcel to the UK before WanbExpress's sorting centre takes it in: the parcel on its
  // way to InPost, then the parcel in hand, and a note on the recipient's account settings.
  ['your parcel is on its way to inpost. please check back for updates', 'registered'],
  ['we have your parcel. please check back for updates', 'accepted'],
  ["we'll apply your my account preferences to this parcel delivery", null],
  // A partner's pre-advice in other words, at the instant of the parcel's data; its sorting centre's arrival, also sent
  // under SupplierAndLastMileReceive; and its courier calling the recipient at the minute of an attempt.
  ['your parcel will soon be handed over to us! it is being prepared by the sender.', 'registered'],
  ['shipment arrived to sorting centre / shipment in the sorting centre', 'in_transit'],
  // A Dutch partner's English copy of its departure from its sorting centre, sent beside its own line coded 200.
  ['departed from the sorting center', 'in_transit'],
  // A last-mile partner's sorting centre taking the parcel in, relayed without a code at the minute of its acceptance,
  // and in shorter words.
  ['your shipment has arrived at sorting center', 'in_transit'],
  ['arrived at sorting center', 'in_transit'],
  // Cainiao's last mile, relayed without the codes AliExpress sends the same lines under: the order created with the
  // parcel's data (CREATE_ORDER_CES), its sorting centre's dispatch (SC_OUTBOUND), and the delivery carrier taking the
  // parcel from it (SL_ACCEPT), the journey going on, not the sender's handover.
  ['shipment order created', 'registered'],
  ['your shipment has been processed at sorting center and ready for shipping', 'in_transit'],
  ['your shipment has been accepted by delivery carrier', 'in_transit'],
  // The handover to DPD for the last mile, after the destination's customs clearance.
  ['parcel handed to dpd', 'in_transit'],
  // Hermes's note that the parcel is on its way to it, relayed between the sorting centre's processing and departure,
  // as Hermes Germany's own tracker reads it.
  ['die sendung wird an hermes weitergeleitet. weitere informationen folgen, sobald uns die sendung erreicht hat.', 'in_transit'],
  ['consignee contacted', null],
  // The origin's processing centre taking the parcel in, collecting it and sending it on, after the sorting
  // centre's departure and before the line's.
  ['arrive at processing center', 'in_transit'],
  ['processing center collecting', 'in_transit'],
  ['delivery from processing center', 'in_transit'],
  // The destination's customs taking the parcel in, an hour before its line coded CustomsCleared.
  ['arrive dest customs', 'customs'],
  // The last-mile partner's collection after the clearance, its transit centre's dispatch and its distribution
  // centre's arrival before the round: the collection is the journey going on, not a new acceptance.
  ['the parcel has been successfully picked up and is being prepared for transportation.', 'in_transit'],
  ['the parcel is dispatched from the transit center to the next destination', 'in_transit'],
  ['the parcel arrives at the distribution center and is prepared for transport to the next destination.', 'in_transit'],
  // iMile's run in Germany that ended before it reached the parcel: no door was tried, so a delay, not an attempt.
  ['<route not completed>', 'in_transit'],
  // A connecting airport's arrival and departure, relayed without a code beside the line-haul's coded copies, and the
  // last-mile partner's record of the parcel's data at the minute of its depot's receipt: the journey goes on.
  ['parcel arrives at transit airport, parcel arrival', 'in_transit'],
  ['parcel is leaving transit airport, parcel leaving port', 'in_transit'],
  ['shipment data processed', 'in_transit'],
  // The UK partner's depot receipt, sent under SupplierAndLastMileReceive and relayed again without a code at the
  // minute of Royal Mail's own mail-centre scan: the journey goes on.
  ['shipment received in depot', 'in_transit'],
]);

// Partners' lines WanbExpress files under a code their words contradict, by code and `normalizeStatusWording` wording:
// a round filed as waiting for collection, hours before its delivery, and the courier's round filed as transit.
const CODED: ReadonlyMap<string, Stage> = new Map(([
  ['LastMileWaitForCollection', 'out of delivery', 'out_for_delivery'],
  ['LastMileInTransit', 'out for delivery, parcel is at courier, delivery expected soon.', 'out_for_delivery'],
] as const).map(([code, wording, stage]) => [JSON.stringify([code, wording]), stage]));

/**
 * A scan's stage by its code, else by the partners' sentences: the tracker relays the last-mile
 * partner's scans in the partner's words, iMile's on a parcel to Germany, most without a code.
 * Null marks a scan that moves nothing.
 */
export function wanbStage(code: string | null, wording: string): Stage | null | undefined {
  const normalized = normalizeStatusWording(wording);
  if (code && CODED.has(JSON.stringify([code, normalized]))) return CODED.get(JSON.stringify([code, normalized]));
  if (code && Object.hasOwn(STAGES, code)) return STAGES[code];
  if (!code && UNCODED.has(normalized)) return UNCODED.get(normalized);
  return (code ? undefined : SHARED_WORDINGS.get(normalized)) ?? imileMappedStage('', wording);
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => wanbStage(code, wording) ?? undefined, gaps: [],
  gapNote: (code, wording) => (wanbStage(code, wording) === null
    ? 'A line that moves nothing, such as a booked flight or delivery day: the parcel keeps the stage it had.' : undefined),
};
