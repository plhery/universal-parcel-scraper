import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's event types: the record's creation, a change of its status,
 * named by the status the tracker's page translates, and a code received from
 * the network, as "Received code: In Transit". The page writes statuses with
 * hyphens or underscores alike.
 */
const CODES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['ShipmentCreated', 'registered'],
  // A draft, and a shipment created but not collected yet.
  ['StatusChanged:draft', 'registered'],
  ['StatusChanged:uncollected', 'registered'],
  // "The shipment is picked up": the courier collected it, and it goes on.
  ['StatusChanged:active', 'accepted'],
  ['StatusChanged:in_transit', 'in_transit'],
  ['StatusChanged:delivered', 'delivered'],
  // The page's last step in place of the delivery: back with its sender.
  ['StatusChanged:returned', 'returned'],
  // A cancelled shipment, or one the network stopped: it will not be delivered as booked.
  ['StatusChanged:canceled', 'exception'],
  ['StatusChanged:exception', 'exception'],
  ['CodeChanged:In Transit', 'in_transit'],
  // Some codes come by their abbreviation: ADH, "Arrived at Delivery Hub", at the hub that delivers it.
  ['CodeChanged:ADH', 'in_transit'],
  ['CodeChanged:Delivery attempt', 'failed_attempt'],
  // A later delivery agreed with the recipient.
  ['CodeChanged:Postponed delivery', 'failed_attempt'],
  // The recipient refused the parcel at the door, or it arrived damaged.
  ['CodeChanged:Delivery attempt - refused', 'exception'],
  ['CodeChanged:Damaged', 'exception'],
]);

/**
 * The tracker page's own sentences, for an event whose type the map does not
 * know. Ready to be picked up is the page's first step, before the transit,
 * for a shipment the courier has not collected yet.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['shipment data has entered the system', 'registered'],
  ['shipment info entered the system', 'registered'],
  ['shipment was successfully created', 'registered'],
  ['the shipment is ready to be picked up', 'registered'],
  ['the shipment is picked up', 'accepted'],
  ['the shipment has been picked up', 'accepted'],
  ['received code: in transit', 'in_transit'],
  ['received code: arrived at delivery hub', 'in_transit'],
  ['the shipment has been delivered', 'delivered'],
  ['delivery attempt failed', 'failed_attempt'],
  ['received code: delivery attempt', 'failed_attempt'],
  ['received code: postponed delivery', 'failed_attempt'],
  ['received code: delivery attempt - refused', 'exception'],
  ['received code: damaged', 'exception'],
  ['the shipment has been canceled', 'exception'],
]);
// "The shipment arrived in the hub: Timisoara".
const HUB = /^the shipment arrived in the hub:\s*\S/;

/** An event type with its status written with underscores. */
function codeKey(code: string): string {
  return code.replace(/^(StatusChanged:)(.+)$/, (_, kind: string, status: string) => kind + status.toLowerCase().replaceAll('-', '_'));
}

/** The stage of one event, by its type, else by the page's sentence. */
export function fanCourierInternationalStage(code: string | null, wording: string): Stage | undefined {
  const known = code ? CODES.get(codeKey(code)) : undefined;
  if (known) return known;
  const words = normalizeStatusWording(wording);
  return WORDINGS.get(words) ?? (HUB.test(words) ? 'in_transit' : undefined);
}

/**
 * What the map says about one event. Statuses no source explains, "notified"
 * and "in progress", stay unknown, open for review.
 */
export const statusMap: CarrierStatusMap = {
  codeKey,
  stage: fanCourierInternationalStage,
  gaps: [],
  wholeWording: true,
};
