import type { ClassifiedStatus } from '../../core/status/index.js';

// Codes and their labels come from the official tracking widget. EN_ROUTE and
// OTHER also cover several distinct milestones and administrative notices.
const codes: Record<string, ClassifiedStatus> = {
  CREATED: { status: 'pending', stage: 'registered' },
  INFORMED: { status: 'pending', stage: 'registered' },
  EN_ROUTE: { status: 'in_transit', stage: 'in_transit' },
  AVAILABLE_FOR_DELIVERY: { status: 'in_transit', stage: 'ready_for_pickup' },
  DELIVERED: { status: 'delivered', stage: 'delivered' },
  DELIVERY_IMPOSSIBLE: { status: 'exception', stage: 'failed_attempt' },
  DELIVERY_REFUSED: { status: 'exception', stage: 'failed_attempt' },
  RETURNED: { status: 'exception', stage: 'returned' },
  DELAYED: { status: 'exception', stage: 'exception' },
  EXPECTED_DELAY: { status: 'exception', stage: 'exception' },
  STOPPED: { status: 'exception', stage: 'exception' },
  CUSTOMS_STOPPED_VAT: { status: 'exception', stage: 'customs' },
};

const accepted: ClassifiedStatus = { status: 'in_transit', stage: 'accepted' };
const moving: ClassifiedStatus = { status: 'in_transit', stage: 'in_transit' };
const customs: ClassifiedStatus = { status: 'in_transit', stage: 'customs' };

/** EN_ROUTE and OTHER wordings that name a milestone of their own. */
const milestones: Record<string, ClassifiedStatus> = {
  'The delivery of the shipment item is in progress.': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  'The shipment item is under transportation.': moving,
  'The shipment item has arrived at the distribution terminal.': moving,
  'Your item is being processed at our sorting center.': moving,
  'The shipment item has been loaded.': moving,
  'The shipment item has been dropped off by sender.': accepted,
  // Handed in at a service point after the day's last collection.
  'The shipment item has been dropped off after latest drop-off time.': accepted,
  'The shipment item has been picked-up for transportation.': accepted,
  'Customs VAT has been paid.': customs,
  'Import Charge sent to recipient.': customs,
};

/** STOPPED wordings for a parcel held on purpose rather than in trouble. */
const holds: Record<string, ClassifiedStatus> = {
  'The shipment item is being customs cleared by us.': customs,
  'The shipment item is being held at a distribution terminal awaiting the booked delivery date or, awaiting an agreement of delivery with the recipient.': moving,
};

export function isPostnordAdministrativeEvent(code: string, description: string): boolean {
  return code === 'OTHER' && [
    'Suggested delivery time.',
    'Information to the driver added by the recipient.',
    'A text message notification has been delivered to the recipient.',
    'A text message notification has been sent to the recipient.',
    'E-mail notification has been sent to the recipient.',
    'Notification sent via APP.',
    'Pick-up at servicepoint, selected by the receiver.',
  ].includes(description);
}

export function classifyPostnordStatus(code: string, description = ''): ClassifiedStatus | undefined {
  if ((code === 'EN_ROUTE' || code === 'OTHER') && Object.hasOwn(milestones, description)) return milestones[description];
  if (code === 'STOPPED' && Object.hasOwn(holds, description)) return holds[description];
  return Object.hasOwn(codes, code) ? codes[code] : undefined;
}
