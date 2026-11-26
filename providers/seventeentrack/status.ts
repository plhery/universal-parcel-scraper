import type { Stage } from '../../generated/catalog.js';

// Official v2 status vocabulary, plus TransportArrived/Departed observed in
// public China Post histories, and LocalPickedUp, the destination's last mile
// receiving the parcel after the carrier handed it over (BFE's "El paquete ha
// sido recibido." in Argentina). Expired describes tracking age, not a scan.
export const SUB_STAGES: Record<string, Stage> = {
  InfoReceived: 'registered',
  InTransit_PickedUp: 'accepted', InTransit_Other: 'in_transit', InTransit_LocalPickedUp: 'in_transit',
  InTransit_Departure: 'in_transit', InTransit_Arrival: 'in_transit',
  InTransit_TransportArrived: 'in_transit', InTransit_TransportDeparted: 'in_transit',
  InTransit_CustomsProcessing: 'customs', InTransit_CustomsReleased: 'in_transit',
  InTransit_CustomsRequiringInformation: 'customs',
  AvailableForPickup_Other: 'ready_for_pickup', OutForDelivery_Other: 'out_for_delivery',
  DeliveryFailure_Other: 'failed_attempt', DeliveryFailure_NoBody: 'failed_attempt',
  DeliveryFailure_Security: 'failed_attempt', DeliveryFailure_Rejected: 'failed_attempt',
  DeliveryFailure_InvalidAddress: 'failed_attempt', Delivered_Other: 'delivered',
  Exception_Other: 'exception', Exception_Returning: 'exception', Exception_Returned: 'returned',
  Exception_NoBody: 'exception', Exception_Security: 'exception', Exception_Damage: 'exception',
  Exception_Rejected: 'exception', Exception_Delayed: 'exception', Exception_Lost: 'exception',
  Exception_Destroyed: 'exception', Exception_Cancel: 'exception',
};

// Correios Brazil's posting and its export unit abroad receiving the item, which 17TRACK files as information received.
const SCANNED = /^objeto (?:postado|recebido na unidade de exporta(?:ção|cao) no pa(?:í|i)s de origem)\.?$/i;
// A shipping partner collecting and moving a USPS item before USPS has it, which 17TRACK files the same way.
const PARTNER_SCANNED = /^(?:(?:arrived|departed) shipping partner facility|picked up by shipping partner)\b/i;
// The arrival at a facility in the partner feed WhatsShip relays for some orders, which 17TRACK files the same way.
const FACILITY_SCANNED = /^shipment arrived at facility\.?$/i;
// A customs step, which 17TRACK can file under the delivery round, as China Post's "Import allowed by destination
// customs" a minute after the round started.
const CUSTOMS = /\bcustoms\b|海关/i;
// A leg between offices, which 17TRACK can file under the delivery round, as Poczta Polska's "In transport" and its
// "Arrival at inward office of exchange" on a parcel's way back to the sender.
const LINE_HAUL = /^in transport\.?$|\boffice of exchange\b/i;

/** Whether a scan filed under the delivery round's code is worded as a leg between offices. */
export function roundCodeOnLineHaul(code: string, description = ''): boolean {
  return SUB_STAGES[code] === 'out_for_delivery' && LINE_HAUL.test(description.trim());
}

/**
 * Whether a scan 17TRACK files under the return's code is worded as a leg in transit: a leg of the return, such
 * as DHL's arrival at a parcel centre on the parcel's way back, which 17TRACK files under the code of the return.
 */
export function returnLeg(code: string, worded: Stage | undefined): boolean {
  return code === 'Exception_Returning' && worded === 'in_transit';
}

/** Transit codes that yield to any reading of the wording: the generic one, and the last mile's receipt, which no specification describes. */
const GENERIC_TRANSIT = new Set(['InTransit_Other', 'InTransit_LocalPickedUp']);

/**
 * The stage a scan's `sub_status` gives it over the stage its wording got
 * (`pending` when no rule read it), or undefined when the code does not
 * outrank the wording. The specific code supplies semantics that Chinese
 * wording cannot provide; the shared delivered, negation and handoff
 * safeguards are kept: generic transit yields to any reading of the wording,
 * a delivery code to wording that does not read as delivered, and a
 * delivery-round code to wording that reads as delivered or as a customs
 * step or release. Information
 * received yields to a scan of the item that 17TRACK files under it.
 */
export function subStatusStage(code: string, worded: Stage, description = ''): Stage | undefined {
  const mapped = Object.hasOwn(SUB_STAGES, code) ? SUB_STAGES[code] : undefined;
  if (!mapped || (GENERIC_TRANSIT.has(code) && worded !== 'pending')) return undefined;
  if (code === 'InfoReceived' && [SCANNED, PARTNER_SCANNED, FACILITY_SCANNED].some((scan) => scan.test(description.trim()))) return undefined;
  if (mapped === 'out_for_delivery' && worded === 'delivered') return undefined;
  if (mapped === 'out_for_delivery' && (worded === 'customs' || (worded === 'in_transit' && CUSTOMS.test(description)))) return undefined;
  return mapped !== 'delivered' || worded === 'delivered' ? mapped : undefined;
}
