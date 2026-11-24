import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * WLD's own scan codes. IR is the order's first scan, when its data reaches
 * WLD's system. The tracker's page names the shipment statuses: AF in the
 * network, CC delivered, CF failed to deliver, UE returned.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['IR', 'registered'],
  ['AF', 'in_transit'],
  ['CC', 'delivered'],
  ['CF', 'failed_attempt'],
  ['UE', 'returned'],
]);

/**
 * The line's own scans, which WLD relays in the line's words under ND, DD and
 * TT. ND covers every kind of line scan, delivery attempts included, so these
 * are staged by their wording.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['acceptance completed', 'in_transit'], // The destination post takes the parcel in from the flight.
  ['forwarding for delivery', 'in_transit'],
  ['arrival for processing', 'in_transit'],
  ['item handed over to delivery man', 'out_for_delivery'],
  ['unsuccessful delivery', 'failed_attempt'],
  // Back at the delivery office after a failed attempt, to be delivered again.
  ['returned for repeated delivery', 'in_transit'],
  ['mail item available for collection at post office', 'ready_for_pickup'],
  ['(return) returned to sender', 'returned'],
]);

/** The stage WLD's map gives a scan's code and wording in `normalizeStatusWording` form. */
export function wldMappedStage(code: string | null, wording: string): Stage | undefined {
  return (code ? CODES.get(code.toUpperCase()) : undefined) ?? WORDINGS.get(wording);
}

/** A scan's stage: its code or wording, else the shared wording rules, else nothing. */
export function wldStage(code: string | null, wording: string): ClassifiedWording | null {
  const mapped = wldMappedStage(code, normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every code and wording seen or named is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => wldMappedStage(code, wording),
  gaps: [],
};
