import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Tiui's status codes, which each movement carries with its wording. A pickup
 * comes first: Tiui documents it and a courier goes to the merchant for it.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  // Registered for a pickup from the merchant, then a courier on the way to it: Tiui does not have the parcel yet.
  ['16', 'registered'],
  ['17', 'registered'],
  ['18', 'accepted'],
  // At Tiui's distribution centre (CEDIS), which the wording names, and on the route being planned.
  ['19', 'in_transit'],
  ['20', 'in_transit'],
  ['9', 'out_for_delivery'],
  // The round ended before the courier reached the address: no attempt at the door, and the parcel goes out again.
  ['21', 'in_transit'],
  ['13', 'delivered'],
]);

/** The stage the map gives a code. */
export function tiuiMappedStage(code: string | null): Stage | undefined {
  return code === null ? undefined : CODES.get(code);
}

/** A movement's stage: its code in the map, else its wording by the shared rules, else nothing. */
export function tiuiStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = tiuiMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => tiuiMappedStage(code),
  gaps: [],
};
