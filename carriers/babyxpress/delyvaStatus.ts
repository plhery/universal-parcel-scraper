import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap, IntentionalStatusGap } from '../../core/status/statusMap.js';

/**
 * Delyva's order status codes, which every courier on the platform shares, with the wording the
 * platform's customer tracker gives each when a scan carries none of its own.
 */
const CODES: ReadonlyMap<number, { wording: string; stage?: Stage }> = new Map([
  [0, { wording: 'Draft', stage: 'registered' }],
  [10, { wording: 'Processing payment', stage: 'registered' }],
  [11, { wording: 'Unpaid order', stage: 'registered' }],
  [99, { wording: 'Failed', stage: 'exception' }],
  [100, { wording: 'Order created', stage: 'registered' }],
  [110, { wording: 'Ready', stage: 'registered' }],
  [200, { wording: 'Pending for collection', stage: 'registered' }],
  [400, { wording: 'Driver out for pickup / pickup start', stage: 'registered' }],
  [450, { wording: 'Arrived for pickup', stage: 'registered' }],
  [475, { wording: 'Pickup failed', stage: 'registered' }],
  [500, { wording: 'Pickup success - collected by courier', stage: 'accepted' }],
  [501, { wording: 'On hold', stage: 'exception' }],
  [555, { wording: 'Hub check-in', stage: 'in_transit' }],
  [556, { wording: 'Hub check-out', stage: 'in_transit' }],
  [600, { wording: 'In transit / delivery start', stage: 'out_for_delivery' }],
  [625, { wording: 'Arrived for delivery', stage: 'out_for_delivery' }],
  [650, { wording: 'Failed to deliver', stage: 'failed_attempt' }],
  [651, { wording: 'Failed delivery - lost/damage', stage: 'exception' }],
  [654, { wording: 'Driver cancelled' }],
  [655, { wording: 'Failed', stage: 'exception' }],
  [661, { wording: 'Returning to sender', stage: 'returned' }],
  [663, { wording: 'Return failed', stage: 'exception' }],
  [670, { wording: 'Return to warehouse', stage: 'failed_attempt' }],
  [671, { wording: 'Reschedule' }],
  [672, { wording: 'Re-attend delivery', stage: 'out_for_delivery' }],
  [700, { wording: 'Item delivered / collected by recipient', stage: 'delivered' }],
  [701, { wording: 'Return successful', stage: 'returned' }],
  [900, { wording: 'Order cancelled', stage: 'exception' }],
  [1000, { wording: 'Order completed' }],
]);

/** The codes that set no stage, so their scan keeps the stage of the one before it. */
export const DELYVA_STATUS_GAPS: readonly IntentionalStatusGap[] = [
  { code: '654', note: 'A driver gave the job up and the order waits for another one.' },
  { code: '671', note: 'The delivery moved to another day, which does not change where the parcel is.' },
  { code: '1000', note: 'The order is closed after its delivery or its return, whichever came last.' },
];

const CODE = /^\d{1,4}$/;

export const delyvaStage = (code: number): Stage | undefined => CODES.get(code)?.stage;
export const delyvaWording = (code: number): string | undefined => CODES.get(code)?.wording;

/** A status map that reads Delyva's codes, for any courier on the platform. */
export const delyvaStatusMap: CarrierStatusMap = {
  stage: (code) => (code && CODE.test(code) ? delyvaStage(Number(code)) : undefined),
  gaps: DELYVA_STATUS_GAPS,
};
