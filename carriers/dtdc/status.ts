import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const STATUS = new Map<string, ClassifiedStatus>([
  ['Pickup Awaited', { status: 'pending', stage: 'registered' }],
  ['Pickup Scheduled', { status: 'pending', stage: 'registered' }],
  ['Booked', { status: 'pending', stage: 'registered' }],
  ['Booked at Origin Branch', { status: 'pending', stage: 'registered' }],
  ['Picked Up', { status: 'in_transit', stage: 'accepted' }],
  ['Pickup Completed', { status: 'in_transit', stage: 'accepted' }],
  ['In Transit', { status: 'in_transit', stage: 'in_transit' }],
  ['Out For Delivery', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['Delivered', { status: 'delivered', stage: 'delivered' }],
  ['RTO Booked', { status: 'exception', stage: 'exception' }],
  // The tracking page's labels.
  ['Pickup requested', { status: 'pending', stage: 'registered' }],
  ['Pickup rescheduled', { status: 'pending', stage: 'registered' }],
  ['Not picked', { status: 'pending', stage: 'registered' }],
  ['On The Way', { status: 'in_transit', stage: 'in_transit' }],
  ['At Processing Centre', { status: 'in_transit', stage: 'in_transit' }],
  ['At Destination', { status: 'in_transit', stage: 'in_transit' }],
  ['Undelivered', { status: 'exception', stage: 'failed_attempt' }],
  ['Reattempt Initiated', { status: 'in_transit', stage: 'in_transit' }],
  // A remark that the parcel is put on a round, before the delivery centre receives it; the round is Out For Delivery.
  ['Scheduled for delivery', { status: 'in_transit', stage: 'in_transit' }],
  ['Return Approval awaited', { status: 'exception', stage: 'exception' }],
  ['Return Initiated', { status: 'exception', stage: 'exception' }],
  ['Return - Initiated', { status: 'exception', stage: 'exception' }],
]);

const STAGE_BY_WORDING = new Map<string, Stage>([...STATUS].map(([label, status]) => [normalizeStatusWording(label), status.stage]));
const STATUS_BY_WORDING = new Map([...STATUS].map(([label, status]) => [normalizeStatusWording(label), status]));
// The page names the hub a parcel reaches or leaves: "Arrived at DELHI", "Dispatched from MATHURA". Its remarks, lines
// without a label, name a centre receiving the parcel on its way, "Received at DELHI Processing Centre" or "… Delivery
// Centre", and the way between two hubs. A booking's "Received at Origin Processing Center" comes with its label.
const HUB_MOVEMENT = /^(?:arrived at|dispatched from) \S|^received at (?!origin\b)\S.* (?:processing|delivery) cent(?:re|er)$|^on its way between \S.* and \S/;

/** A status label of the feed or the tracking page, in any case. */
export function dtdcStatus(wording: string): ClassifiedStatus | undefined {
  const normal = normalizeStatusWording(wording);
  return STATUS_BY_WORDING.get(normal) ?? (HUB_MOVEMENT.test(normal) ? { status: 'in_transit', stage: 'in_transit' } : undefined);
}

const DELIVERED = normalizeStatusWording('Delivered');

/**
 * What the map says about one scan: its wording, when that is one of the status labels the
 * parser reads, or a line it reads without a label: a hub's arrival or departure, a centre's
 * receipt and the way between two hubs. The scan's own label, which the parser reads first, is
 * not stored; a scan worded with a label carries the same step in it. A delivery is a return on
 * the return leg, which the map is not asked by.
 */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => (wording === DELIVERED ? undefined : STAGE_BY_WORDING.get(wording) ?? (HUB_MOVEMENT.test(wording) ? 'in_transit' : undefined)),
  gaps: [{ wording: DELIVERED, note: "Delivered on the forward leg, or returned to the sender on the return leg: the map is not asked by the scan's leg." }],
};
