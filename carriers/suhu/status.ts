import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Suhu's scan codes. The first digit is the leg: 1 in China, 2 the export and
 * the flight, 3 the destination's last mile. Another code falls to the shared
 * wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['1004', 'registered'], // Shipment data received.
  ['1002', 'accepted'], // Domestic sorting center inbound: Suhu has the parcel.
  ['1003', 'in_transit'],
  ['1009', 'in_transit'],
  ['1010', 'in_transit'],
  ['1099', 'in_transit'],
  ['2001', 'in_transit'],
  // Export clearance success. The destination's clearance also gets it, after the arrival scan.
  ['2003', 'in_transit'],
  ['2004', 'in_transit'],
  ['2005', 'in_transit'],
  ['2006', 'in_transit'],
  // Arrive at the destination and clear the customs: the clearance has started.
  ['2008', 'customs'],
  ['3099', 'in_transit'], // Delivery to local courier.
  ['3001', 'in_transit'], // Accepted by last-mile carrier.
]);

/** The stage Suhu's map gives a scan's code. */
export function suhuMappedStage(code: string | null): Stage | undefined {
  return code ? CODES.get(code) : undefined;
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function suhuStage(code: string | null, wording: string): ClassifiedWording | null {
  const mapped = suhuMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every code seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => suhuMappedStage(code),
  gaps: [],
};
