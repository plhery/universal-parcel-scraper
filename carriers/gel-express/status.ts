import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * GEL's statuses, in German. The tracker's progress rail names its steps, and
 * its former tracker, run by GEL's IT provider, named the hub and the depot.
 * The status carries no code.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  // A collection is booked; GEL does not have the parcel yet.
  ['sendung wird abgeholt', 'registered'],
  ['sendung abgeholt', 'accepted'],
  // Sorted overnight at GEL's logistics centre.
  ['sendung im nachtumschlag', 'in_transit'],
  ['sendung im logistik-center kassel eingetroffen', 'in_transit'],
  ['sendung im zustelldepot', 'in_transit'],
  ['sendung lagernd im empfangsdepot', 'in_transit'],
  // At the depot while GEL agrees a delivery appointment with the recipient.
  ['im avisierungsprozess', 'in_transit'],
  ['sendung in zustellung', 'out_for_delivery'],
  ['sendung zugestellt', 'delivered'],
]);

/** The stage the map gives GEL's wording, if it knows it. */
export function gelStatusStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/**
 * A status's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function gelStage(wording: string): ClassifiedWording | null {
  const mapped = gelStatusStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The status is wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : gelStatusStage(wording)),
  gaps: [],
};
