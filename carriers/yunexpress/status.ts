import type { CarrierStatus } from '../../core/result/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const ENTRIES: ReadonlyArray<readonly [string, ClassifiedStatus]> = [
  ['Shipment information received', { status: 'pending', stage: 'registered' }],
  ['Shipment picked up', { status: 'in_transit', stage: 'accepted' }],
  ['Arrived at origin facility', { status: 'in_transit', stage: 'in_transit' }],
  ['Departed from sort facility', { status: 'in_transit', stage: 'in_transit' }],
  ['Shipment is in transit to next facility', { status: 'in_transit', stage: 'in_transit' }],
  ['The country of origin commences customs declaration.', { status: 'in_transit', stage: 'customs' }],
  ['Arrived at the origin international airport', { status: 'in_transit', stage: 'in_transit' }],
  ['Clearence processing completed - Export', { status: 'in_transit', stage: 'in_transit' }],
  ['International flight has departed', { status: 'in_transit', stage: 'in_transit' }],
  ['International flight has arrived', { status: 'in_transit', stage: 'in_transit' }],
  ['Start Customs Clearence', { status: 'in_transit', stage: 'customs' }],
  ['Collected at Cargo Terminal', { status: 'in_transit', stage: 'in_transit' }],
  ['Clearance processing completed - Import', { status: 'in_transit', stage: 'in_transit' }],
  ['Customs inspection - Import', { status: 'in_transit', stage: 'customs' }],
  ['In clearance processing - Import', { status: 'in_transit', stage: 'customs' }],
  ['Arrived at the warehouse of Customs Broker', { status: 'in_transit', stage: 'customs' }],
  ['Arrived at sort facility', { status: 'in_transit', stage: 'in_transit' }],
  ['Shipment is ready for outbound', { status: 'in_transit', stage: 'in_transit' }],
  ['Departed from facility', { status: 'in_transit', stage: 'in_transit' }],
  // The hand-over to the destination's last-mile carrier, not to the recipient.
  ['Delivered to local carrier', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at sorting center', { status: 'in_transit', stage: 'in_transit' }],
  ['The package left sorting center', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at GOFO Regional Destination Facility', { status: 'in_transit', stage: 'in_transit' }],
  ['The driver is out for delivery', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['Departure from the international sorting center', { status: 'in_transit', stage: 'in_transit' }],
  ['Shipment in transit to DHL', { status: 'in_transit', stage: 'in_transit' }],
  ['Preparing for delivery', { status: 'in_transit', stage: 'in_transit' }],
  // Last-mile wording the feed relays without codes. DPD files its data
  // record before the parcel leaves China and its proof of delivery after the
  // delivery scan. The DHL Parcel Netherlands lines follow that carrier's codes.
  // A partner's order pre-advice is a data record too.
  ['Sender goods issue', { status: 'pending', stage: 'registered' }],
  ['POD available', { status: 'delivered', stage: 'delivered' }],
  ['Shipment not yet received or processed', { status: 'pending', stage: 'registered' }],
  ['Order information received. We\'re expecting your parcel to arrive with us.', { status: 'pending', stage: 'registered' }],
  ['We deliver your shipment at a DHL ServicePoint', { status: 'in_transit', stage: 'in_transit' }],
  ['Request by the recipient for delivery at DHL ServicePoint', { status: 'in_transit', stage: 'in_transit' }],
  ['Delivery instruction changed to delivery at DHL ServicePoint', { status: 'in_transit', stage: 'in_transit' }],
  ['New delivery attempt on the next delivery day', { status: 'in_transit', stage: 'in_transit' }],
  ['Delivery planned at the CityHub', { status: 'in_transit', stage: 'in_transit' }],
  ['Delivery planned in the route of the courier', { status: 'in_transit', stage: 'in_transit' }],
  ['Entered into handheld device of the courier', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['Handed over to the courier', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['Your package is ready to be picked up.', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  ['Your shipment has been delivered to the postal operator of the country of destination and will be delivered in the coming days.', { status: 'in_transit', stage: 'in_transit' }],
  ['Parcel is handled', { status: 'in_transit', stage: 'in_transit' }],
  ['First parcel scan along Poste Italiane’s logistic network', { status: 'in_transit', stage: 'in_transit' }],
  ['TASK ASSIGNED', { status: 'in_transit', stage: 'in_transit' }],
  ['OUTBOUND SCANNED', { status: 'in_transit', stage: 'in_transit' }],
  ['ORDER EXCEPTION RELEASED', { status: 'in_transit', stage: 'in_transit' }],
  ['DELIVERING, WAIT FOR CONSIGNEE PICK UP', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  // A courier partner's acceptance follows the scans of the network that
  // brought the parcel to it: a hand-over, not the parcel's acceptance.
  ['Package accepted at courier partner', { status: 'in_transit', stage: 'in_transit' }],
];

// A relayed notice about the parcel rather than a scan of it names no stage,
// so the parcel keeps the one it had: here a reminder to collect it that
// failed to send.
const NOTICE = normalizeStatusWording('REMINDER EMAIL SENT FAILED');

/** Whether the wording is a relayed notice the map gives no stage on purpose. */
export function isYunExpressNotice(description: string): boolean {
  return normalizeStatusWording(description) === NOTICE;
}

/** Yuntrack's scan wording, compared without case or repeated spaces. */
const WORDING = new Map(ENTRIES.map(([text, status]) => [normalizeStatusWording(text), status]));

// The page labels these latest-event codes Processing and Transit. They give
// the parcel's status when its newest wording is new, never a scan's stage.
const CODE_STATUS = new Map<unknown, CarrierStatus>([[10, 'pending'], [20, 'in_transit'], [30, 'in_transit']]);

export function yunExpressStatus(description: string, code?: unknown): ClassifiedStatus | undefined {
  // The latest event's explicit delivered code also covers partner wording
  // containing variable delivery notes. It is never inherited by older scans.
  if (code === 50) return { status: 'delivered', stage: 'delivered' };
  return WORDING.get(normalizeStatusWording(description));
}

/** The status the latest event's own code states, for wording the map does not know. */
export function yunExpressCodeStatus(code: unknown): CarrierStatus | undefined {
  return CODE_STATUS.get(code);
}

/**
 * What the map says about one scan. Scans carry no code: the delivered code
 * comes only with the latest event and is never a scan's own.
 */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => yunExpressStatus(wording)?.stage,
  gaps: [{ wording: NOTICE, note: 'A reminder that failed to send, not a movement: the parcel keeps the stage it had.' }],
};
