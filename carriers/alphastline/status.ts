import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/** The nodes Alphastline names its scans by. Another node falls to the shared wording rules. */
const NODES: ReadonlyMap<string, Stage> = new Map([
  ['Created', 'registered'], // The order's data received, before pickup.
  ['PickedUp_CollectedParcel', 'accepted'], // The parcel collected from the shop.
  ['InTransit_Other', 'in_transit'], // The sorting centre's scans, the departure and the line's scans on the way.
]);

interface Entry { readonly wording: string; readonly unmapped?: boolean; readonly note?: string }
/** The line's notices, filed under a node on the way: no scan, so no stage, whatever the node. */
const GAPS = (statuses.entries as readonly Entry[]).filter((entry) => entry.unmapped)
  .map((entry) => ({ wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' }));
const GAP_NOTES = new Map(GAPS.map((gap) => [gap.wording, gap.note]));
const isGap = (wording: string): boolean => GAP_NOTES.has(normalizeStatusWording(wording));

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

/** A scan's stage: none for a notice, else its node, else the shared wording rules, else nothing. */
export function alphastlineStage(node: string | null, wording: string): ClassifiedWording | null {
  if (isGap(wording)) return null;
  const mapped = alphastlineMappedStage(node);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every node seen is mapped; the line's notices are gaps by their wording, whatever the node. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => GAP_NOTES.has(wording) ? undefined : alphastlineMappedStage(code),
  gaps: GAPS,
  gapNote: (_code, wording) => GAP_NOTES.get(wording),
};
