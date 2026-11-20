import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** Gaint's own wordings, in `normalizeStatusWording` form. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['booking received', 'registered'], // The order booked on the platform, before a pick-up.
]);
// A return to origin, as Indian couriers word it: "RTO Initiated", "RTO Delivered" to the shipper.
const RETURN = /^rto\b/;

/** The stage Gaint's wording gives a scan, read whole, or undefined for a wording it does not know. */
export function gaintMappedStage(wording: string): Stage | undefined {
  const key = wording.toLocaleLowerCase('en-US').trim().split(/\s+/).join(' ');
  return WORDINGS.get(key) ?? (RETURN.test(key) ? 'returned' : undefined);
}

/** A scan's stage: Gaint's map, else the shared rules, which read the partner couriers' scans it relays. */
export function gaintStage(wording: string): ClassifiedWording {
  const mapped = gaintMappedStage(wording);
  return mapped ? { stage: mapped, source: 'carrier_map' } : classifyWording(wording);
}

/** The scans carry no code; a wording the map does not know is the shared rules'. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : gaintMappedStage(wording)),
  gaps: [],
};
