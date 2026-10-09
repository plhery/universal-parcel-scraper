import type { Stage } from '../../generated/catalog.js';

// Official v2 status vocabulary, plus TransportArrived/Departed observed in
// public China Post histories. Expired describes tracking age, not a scan.
export const SUB_STAGES: Record<string, Stage> = {
  InfoReceived: 'registered',
  InTransit_PickedUp: 'accepted', InTransit_Other: 'in_transit',
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

/**
 * The stage a scan's `sub_status` gives it over the stage its wording got
 * (`pending` when no rule read it), or undefined when the code does not
 * outrank the wording. The specific code supplies semantics that Chinese
 * wording cannot provide; the shared delivered, negation and handoff
 * safeguards are kept: generic transit yields to any reading of the wording,
 * and a delivery code to wording that does not read as delivered.
 */
export function subStatusStage(code: string, worded: Stage): Stage | undefined {
  const mapped = Object.hasOwn(SUB_STAGES, code) ? SUB_STAGES[code] : undefined;
  if (!mapped || (code === 'InTransit_Other' && worded !== 'pending')) return undefined;
  return mapped !== 'delivered' || worded === 'delivered' ? mapped : undefined;
}
