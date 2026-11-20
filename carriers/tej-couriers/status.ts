import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// A return to the sender. The page would read its delivery back as a delivery.
const RETURN = /\bRTO\b|\bRETURN(?:ED)?\s+TO\s+(?:ORIGIN|SHIPPER|SENDER|CONSIGNOR)\b/i;
/**
 * Tej's scans come without a code, so their wordings stage them. The page's
 * own script reads a delivery from "Delivery Done" and a delivery run from
 * "RunSheet".
 */
const DELIVERED = /\bDELIVERY\s*DONE\b/i;
const OUT_FOR_DELIVERY = /\bRUN\s*SHEET\b/i;

/** The stage Tej's own wordings give a scan. */
export function tejMappedStage(wording: string): Stage | undefined {
  const exact: Record<string, Stage> = {
    booked: 'registered', 'in transit': 'in_transit', 'out for delivery': 'out_for_delivery', delivered: 'delivered',
    'booking inward done': 'accepted', outscan: 'in_transit', inscan: 'in_transit',
  };
  const own = exact[wording.trim().toLowerCase()];
  if (own) return own;
  // A return on its way is an exception; one delivered back has been returned.
  if (RETURN.test(wording)) return DELIVERED.test(wording) ? 'returned' : 'exception';
  if (DELIVERED.test(wording)) return 'delivered';
  if (OUT_FOR_DELIVERY.test(wording)) return 'out_for_delivery';
  return undefined;
}

/** A scan's stage: Tej's own wording, else the shared wording rules, else nothing. */
export function tejStage(wording: string): ClassifiedWording | null {
  if (wording.trim().toLowerCase() === 'pending') return null;
  const mapped = tejMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The page's summary when no scan names a step: booked, then in transit once a second scan comes. */
export function tejSummaryStage(scans: number): Stage {
  return scans > 1 ? 'in_transit' : 'registered';
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => tejMappedStage(wording),
  gaps: [{ wording: 'pending', note: 'No reason or new movement is stated; keep the preceding scan’s stage.' }],
};
