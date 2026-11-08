import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Kuayuan's scan codes. The shipment's status uses the same codes as its scans
 * (AF, ND), and the home page names the rest of them: CC delivered, CF failed
 * to deliver, UE returned. Another code falls to the shared wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['AF', 'in_transit'], // Arrived at an operations centre.
  ['DF', 'in_transit'], // Handling at the centre done.
  ['ECKSBG', 'in_transit'], // Export customs declaration.
  ['ECYDG', 'in_transit'], // Arrived at the port.
  ['JH', 'in_transit'], // Handed to the airline.
  ['ND', 'in_transit'], // In transit: the scans of the line Kuayuan hands the parcel to.
  ['CC', 'delivered'],
  ['CF', 'failed_attempt'],
  ['UE', 'returned'],
]);

/** The stage Kuayuan's map gives a scan's code. */
export function kuayuanMappedStage(code: string | null): Stage | undefined {
  return code ? CODES.get(code.toUpperCase()) : undefined;
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function kuayuanStage(code: string | null, wording: string): ClassifiedWording | null {
  const mapped = kuayuanMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every code seen or named is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => kuayuanMappedStage(code),
  gaps: [],
};
