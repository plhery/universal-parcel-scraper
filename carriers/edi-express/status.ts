import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of EDI Express's shipment page: its shipment status, without the day it ends
 * with, and the milestones the parser makes of the page's dated fields. None carries a code.
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  // The page's pickup day.
  [/^picked up$/, 'accepted'],
  // A trailer leaving for the destination's state: "Trailer dispatched to AZ".
  [/^trailer dispatched to [a-z]{2}(?: on \d{1,2}\/\d{1,2}\/\d{4})?$/, 'in_transit'],
  // The page's out-for-delivery day.
  [/^out for delivery$/, 'out_for_delivery'],
  // The page's delivery day.
  [/^delivered$/, 'delivered'],
];

/** The stage the map gives EDI Express's wording, if it knows it. */
export function ediMappedStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return WORDINGS.find(([pattern]) => pattern.test(normalized))?.[1];
}

/** A status's stage from the map, else the shared rules on it, else nothing, which keeps it visible for review. */
export function ediStage(wording: string): ClassifiedWording | null {
  const mapped = ediMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The page gives no codes: its whole wording sets the stage. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : ediMappedStage(wording)),
  gaps: [],
  wholeWording: true,
};
