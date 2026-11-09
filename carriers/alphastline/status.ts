import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** The nodes Alphastline names its scans by. Another node falls to the shared wording rules. */
const NODES: ReadonlyMap<string, Stage> = new Map([
  ['Created', 'registered'], // The order's data received, before pickup.
]);

/**
 * The shipment statuses the home page's tracker sorts its answers by: `Pending` waits for a
 * waybill number, `ToPickuped` for pickup, `Sented` is shipped, `Finished` delivered and
 * `Failed` an exception. `Default` is the list of all answers, not a status.
 */
const STATUSES: ReadonlyMap<string, Stage> = new Map([
  ['Pending', 'registered'],
  ['ToPickuped', 'registered'],
  ['Sented', 'in_transit'],
  ['Finished', 'delivered'],
  ['Failed', 'exception'],
]);

/** The stage Alphastline's map gives a scan's node. */
export function alphastlineMappedStage(node: string | null): Stage | undefined {
  return node ? NODES.get(node) : undefined;
}

/** The stage a shipment status gives the parcel. */
export function alphastlineShipmentStage(status: string): Stage | undefined {
  return STATUSES.get(status);
}

/** A scan's stage: its node, else the shared wording rules, else nothing. */
export function alphastlineStage(node: string | null, wording: string): ClassifiedWording | null {
  const mapped = alphastlineMappedStage(node);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every node seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => alphastlineMappedStage(code),
  gaps: [],
};
