import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const REGISTERED: ClassifiedStatus = { status: 'pending', stage: 'registered' };
const ACCEPTED: ClassifiedStatus = { status: 'in_transit', stage: 'accepted' };
const IN_TRANSIT: ClassifiedStatus = { status: 'in_transit', stage: 'in_transit' };
const OUT_FOR_DELIVERY: ClassifiedStatus = { status: 'out_for_delivery', stage: 'out_for_delivery' };
const FAILED_ATTEMPT: ClassifiedStatus = { status: 'exception', stage: 'failed_attempt' };
const DELIVERED: ClassifiedStatus = { status: 'delivered', stage: 'delivered' };
const EXCEPTION: ClassifiedStatus = { status: 'exception', stage: 'exception' };
const RETURNED: ClassifiedStatus = { status: 'exception', stage: 'returned' };

// Event codes seen on the tracking page. A label is only data from the
// shipper, not a parcel SpeedX holds, and nor is the pickup it books.
const CODES = new Map<string, ClassifiedStatus>([
  ['50001', REGISTERED],
  ['51001', REGISTERED],
  // A pickup that failed at the shipper's, such as for a parcel count that did not match the
  // booking: SpeedX still does not hold the parcel, and a later pickup collects it.
  ['51107', REGISTERED],
  // The driver collected the booked pickup from the shipper.
  ['51005', ACCEPTED],
  // The parcel on its way from the shipper to SpeedX's origin facility, between the label and the arrival there.
  ['50002', IN_TRANSIT],
  ['52002', IN_TRANSIT],
  ['57112', IN_TRANSIT],
  ['57101', IN_TRANSIT],
  ['57102', IN_TRANSIT],
  ['57113', IN_TRANSIT],
  ['57104', OUT_FOR_DELIVERY],
  ['57607', FAILED_ATTEMPT],
  ['57614', FAILED_ATTEMPT],
  // The day's note on a parcel not delivered that day; it goes out again the next morning.
  ['57409', IN_TRANSIT],
  ['57201', DELIVERED],
  ['57413', EXCEPTION],
  ['57504', EXCEPTION],
  ['59116', EXCEPTION],
]);

// The category each event carries, for codes not seen yet. Pickup holds the
// label scan, so it and any other category are left to the wording rules.
const CATEGORIES = new Map<string, ClassifiedStatus>([
  ['ORIGIN_HANDLING', IN_TRANSIT],
  ['LAST_MILE_ENROUTE', IN_TRANSIT],
  ['LAST_MILE_DELIVERED', DELIVERED],
  ['LAST_MILE_ATTEMPTED', FAILED_ATTEMPT],
  ['LAST_MILE_UNDELIVERED', EXCEPTION],
  ['LAST_MILE_INTERCEPT', EXCEPTION],
  ['LAST_MILE_RETURNS', RETURNED],
]);

/** An event's stage from its code, else from its category; undefined for the wording rules to decide. */
export function speedxStatus(code: string, category = ''): ClassifiedStatus | undefined {
  return CODES.get(code) ?? CATEGORIES.get(category);
}

/**
 * What the map says about one scan, by its event code. A code the map does not
 * list takes its stage from the event's category, which the code alone does
 * not carry, so it is not answered.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? CODES.get(code)?.stage : undefined),
  gaps: [],
};
