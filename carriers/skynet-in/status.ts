import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The label keys Skynet India's tracking service gives a shipment and each of its scans, which
 * the tracking page translates under `tracking.events`, with the English label it shows and the
 * stage each one means. Skynet India picks the shipment up from the sender, books it out of its
 * hubs and hands it to airlines and its partners abroad, who clear and deliver it. A key the map
 * does not know stays unstaged, and the scan's wording goes to the shared rules.
 */
const KEYS: ReadonlyMap<string, { readonly label: string; readonly stage?: Stage }> = new Map([
  ['booked', { label: 'Booked', stage: 'registered' }],
  // The sender's pickup is still to come.
  ['pendingPickup', { label: 'Pending pickup', stage: 'registered' }],
  ['collection', { label: 'Collection', stage: 'accepted' }],
  ['inscanned', { label: 'Inscanned', stage: 'in_transit' }],
  ['processed', { label: 'Processed', stage: 'in_transit' }],
  ['sorted', { label: 'Sorted', stage: 'in_transit' }],
  ['reweight', { label: 'Reweight', stage: 'in_transit' }],
  ['hubArrival', { label: 'Hub arrival', stage: 'in_transit' }],
  ['handover', { label: 'Handover', stage: 'in_transit' }],
  ['flightDeparture', { label: 'Flight departure', stage: 'in_transit' }],
  ['flightArrival', { label: 'Flight arrival', stage: 'in_transit' }],
  ['inTransit', { label: 'In transit', stage: 'in_transit' }],
  ['customs', { label: 'Customs', stage: 'customs' }],
  ['customsPending', { label: 'Customs pending', stage: 'customs' }],
  ['customsDocs', { label: 'Customs docs', stage: 'customs' }],
  ['customsHold', { label: 'Customs hold', stage: 'customs' }],
  // Cleared, the shipment moves on.
  ['customsCleared', { label: 'Customs cleared', stage: 'in_transit' }],
  ['documentHold', { label: 'Document hold', stage: 'exception' }],
  ['paymentHold', { label: 'Payment hold', stage: 'exception' }],
  ['addressHold', { label: 'Address hold', stage: 'exception' }],
  ['onHold', { label: 'On hold', stage: 'exception' }],
  ['outForDelivery', { label: 'Out for delivery', stage: 'out_for_delivery' }],
  ['attempted', { label: 'Attempted', stage: 'failed_attempt' }],
  ['undelivered', { label: 'Undelivered', stage: 'failed_attempt' }],
  ['delivered', { label: 'Delivered', stage: 'delivered' }],
  ['return', { label: 'Return', stage: 'returned' }],
  // The page files a cancelled booking under its exception badge.
  ['cancelled', { label: 'Cancelled', stage: 'exception' }],
  ['information', { label: 'Information' }],
  ['documentation', { label: 'Documentation' }],
]);

/** The English label the tracking page shows for a label key, or undefined for a key it does not name. */
export function skynetInLabel(key: string): string | undefined {
  return KEYS.get(key)?.label;
}

/** The stage of a label key, or undefined for a key the map leaves out or does not know. */
export function skynetInStage(key: string): Stage | undefined {
  return KEYS.get(key)?.stage;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? skynetInStage(code) : undefined),
  gaps: [
    { code: 'information', note: 'A message about the shipment; it moves nothing and keeps the stage of the scan before it.' },
    { code: 'documentation', note: 'Paperwork for the shipment; it moves nothing and keeps the stage of the scan before it.' },
  ],
};
