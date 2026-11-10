import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, SHARED_WORDINGS, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { imileMappedStage } from '../imile/status.js';

const STAGES: Readonly<Record<string, Stage>> = {
  DataReceived: 'registered', SupplierDataReceived: 'registered', OriginalWarehouseReceive: 'accepted',
  OriginalWarehouseProcess: 'in_transit', OriginalWarehouseDeparture: 'in_transit',
  LinehaulAgencyReceive: 'in_transit', LinehaulAgencyDeparture: 'in_transit', LinehaulDeparture: 'in_transit',
  LinehaulArrival: 'in_transit', CustomsCleared: 'in_transit', SupplierAndLastMileReceive: 'in_transit',
  LastMileInTransit: 'in_transit', LastMileOutForDelivery: 'out_for_delivery', LastMileDeliveryReady: 'out_for_delivery',
  LastMileDeliveryFailed: 'failed_attempt', LastMileDelivered: 'delivered',
};

// The last-mile partners' scans relayed without a code, by `normalizeStatusWording` wording: a US
// partner's between its receipt and the delivery run, and DHL's in Germany.
const UNCODED: ReadonlyMap<string, Stage> = new Map([
  ['in processing at transit facility.', 'in_transit'],
  // The same partner's departure from its facility and its local facility's receipt before the delivery run.
  ['parcel departed from facility.', 'in_transit'],
  ['parcel received by local facility.', 'in_transit'],
  ['in transit to next facility.', 'in_transit'],
  ['in transit to next facility', 'in_transit'],
  // USPS's notice of a parcel still moving but behind its expected day.
  ['in transit, arriving late', 'in_transit'],
  ['it is currently in transit to the next facility', 'in_transit'],
  ['the package is being transferred to the next facility', 'in_transit'],
  ['the shipment has been processed in the parcel center of origin', 'in_transit'],
  ['the shipment arrived in the region of recipient and will be transported to the delivery base in the next step.', 'in_transit'],
  // Held at the delivery base for another day: no round, so no attempt.
  ['the shipment has been postponed and will probably be delivered on the next working day', 'in_transit'],
  ['the shipment has been loaded onto the delivery vehicle. delivery is expected to take place today.', 'out_for_delivery'],
  // After the sorting centre's departure, before the partner that delivers it takes the parcel.
  ['parcel is ready for hand over to distributor', 'in_transit'],
]);

/**
 * A scan's stage by its code, else by the partners' sentences: the tracker relays the last-mile
 * partner's scans in the partner's words, iMile's on a parcel to Germany, most without a code.
 * Null marks a scan that moves nothing.
 */
export function wanbStage(code: string | null, wording: string): Stage | null | undefined {
  if (code && Object.hasOwn(STAGES, code)) return STAGES[code];
  const normalized = normalizeStatusWording(wording);
  return (code ? undefined : UNCODED.get(normalized) ?? SHARED_WORDINGS.get(normalized)) ?? imileMappedStage('', wording);
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => wanbStage(code, wording) ?? undefined, gaps: [],
  gapNote: (code, wording) => (wanbStage(code, wording) === null
    ? 'A line that moves nothing, such as a booked flight or delivery day: the parcel keeps the stage it had.' : undefined),
};
