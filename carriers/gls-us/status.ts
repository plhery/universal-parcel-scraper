import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';

// GLS US's scan wordings, in `normalizeStatusWording` form. Other wording is left to the shared classifier.
const SCANS = new Map<string, ClassifiedStatus>([
  ['label created', { status: 'pending', stage: 'registered' }],
  ['scanned at delivery depot', { status: 'in_transit', stage: 'in_transit' }],
  ['on route for delivery', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['shipment delivered', { status: 'delivered', stage: 'delivered' }],
]);
// The arrival scan names the day the parcel is due: "ARRIVAL SCAN - DELIVERY SCHED FOR 07/15/2026".
const ARRIVAL = /^arrival scan(?: - delivery sched for \d{2}\/\d{2}\/\d{4})?$/;

// The shipment's own status, which the tracking page shows above the scans and reads by these words.
const SUMMARIES = new Map<string, ClassifiedStatus>([
  ['label created', { status: 'pending', stage: 'registered' }],
  ['in transit', { status: 'in_transit', stage: 'in_transit' }],
  ['out for delivery', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['delivered', { status: 'delivered', stage: 'delivered' }],
  ['returned', { status: 'exception', stage: 'returned' }],
]);

/** A scan's stage, by its wording as GLS US writes it. */
export function glsUsScanStatus(description: string): ClassifiedStatus | undefined {
  const wording = normalizeStatusWording(description);
  return SCANS.get(wording) ?? (ARRIVAL.test(wording) ? { status: 'in_transit', stage: 'in_transit' } : undefined);
}

/** The shipment's status as the reply names it, such as "out for delivery". */
export function glsUsShipmentStatus(status: string): ClassifiedStatus | undefined {
  return SUMMARIES.get(normalizeStatusWording(status));
}

/** What the map says about one scan: its wording, which alone stages it. */
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => glsUsScanStatus(wording)?.stage, gaps: [], wholeWording: true };
