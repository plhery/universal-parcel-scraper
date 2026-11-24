import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Obibox's status codes, which every scan carries beside its English description. The tracking
 * page words a scan from its code alone. Before the collection, the shipment is ready, first
 * pending, then engaged; Obibox then collects it from the shop, takes it out and delivers it,
 * to the recipient in person or in a safe place. The codes the sample does not show are those
 * the page's script names, with the step it shows for them: ready for delivery is a parcel
 * processed in Obibox's facility.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['shipment_ready_pending', 'registered'],
  ['shipment_ready_engaged', 'registered'],
  ['pickup_confirmed', 'accepted'],
  ['shipment_ready_for_delivery', 'in_transit'],
  ['on_delivery', 'out_for_delivery'],
  ['shipment_ready_on_delivery', 'out_for_delivery'],
  ['out_for_delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
  ['delivered_recipient_here', 'delivered'],
  ['delivered_recipient_not_here', 'delivered'],
]);
// "delivery_attempt_2", which the page shows as the second delivery attempt.
const ATTEMPT = /^delivery_attempt_\d{1,2}$/;

/** The part of a code the map reads: an attempt's code without its count. */
const codeKey = (code: string): string => (ATTEMPT.test(code) ? 'delivery_attempt' : code);

/** The stage Obibox's map gives a status code, if it knows it. */
export function obiboxMappedStage(code: string): Stage | undefined {
  return ATTEMPT.test(code) ? 'failed_attempt' : CODES.get(code);
}

/**
 * A scan's stage from its code, else from its description by the shared wording rules. A scan
 * neither knows stays without a stage, so it remains visible for review.
 */
export function obiboxStage(code: string, description: string): ClassifiedWording | null {
  const mapped = obiboxMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Scans are read by their code; a wording without one gets no stage from the map. */
export const statusMap: CarrierStatusMap = {
  codeKey,
  stage: (code) => (code ? obiboxMappedStage(code) : undefined),
  gaps: [],
};
