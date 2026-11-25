import { languageStageStatus, type ClassifiedStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['ORDER_CREATION', 'registered'],
  ['FIRST_MILE_ARRIVE', 'accepted'],
  ['FIRST_MILE_DEPART', 'in_transit'],
  ['DEPART_CONFIRM_OC', 'in_transit'],
  // Export customs in the country of origin, before the flight, and its clearance done, whose code comes
  // with spaces.
  ['ARRIVE_ORIN_CUSTOMS', 'in_transit'],
  ['EXPORT CUSTOMS COMPLETE', 'in_transit'],
  ['ARRIVE_CONFIRM_OC', 'in_transit'],
  ['MAIN_LINE_DEPART', 'in_transit'],
  ['MAIN_LINE_ARRIVE', 'in_transit'],
  ['CUSTOMS_PROCESSING', 'customs'],
  ['CUSTOMS_COMPLETE', 'in_transit'],
  ['IN_TRANSIT', 'in_transit'],
  ['IN_TRANSIT_CARRIER', 'in_transit'],
  // "Delivered to local carrier" is a handoff, before final delivery.
  ['TRANSITHUB_ARRIVE', 'in_transit'],
]);

// The partner feed WhatsShip relays without node codes, such as YunExpress's, by its wording. Its own status
// number agrees: 10 for the order data, 20 for the rows that move the parcel.
const CODELESS: ReadonlyMap<string, Stage> = new Map([
  ['shipment information received', 'registered'],
  ['shipment arrived at facility', 'in_transit'],
  ['sent to next destination', 'in_transit'],
]);

/** The scan code, with explicit delivery wording where the code is ambiguous; a code-less scan by its wording. */
export function whatsShipStage(code: string | null, wording: string): Stage | undefined {
  if (!code) return CODELESS.get(normalizeStatusWording(wording));
  const text = wording.trim();
  if (code === 'DELIVERY_ATTEMPT') {
    if (/^out for delivery[.!]?$/i.test(text)) return 'out_for_delivery';
    if (/^(?:delivery attempt (?:failed|unsuccessful)|delivery failed)(?:[,:.]|$)/i.test(text)) return 'failed_attempt';
    return undefined;
  }
  if (code === 'DELIVERED') return /^delivered(?:[,.]|$)/i.test(text) ? 'delivered' : undefined;
  return STAGES.get(code);
}

export function whatsShipStatus(code: string | null, wording: string): ClassifiedStatus | undefined {
  const stage = whatsShipStage(code, wording);
  return stage ? { stage, status: languageStageStatus(stage) } : undefined;
}

export const statusMap: CarrierStatusMap = {
  stage: whatsShipStage,
  gaps: [],
};
