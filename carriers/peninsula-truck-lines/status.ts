import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of Peninsula's shipment log, each row's `activity`, and of the
 * shipment's status line, its `proStatus`. Neither carries a code. Rows use
 * short terminal words; the status line is a sentence that dates its event.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['pickup', 'accepted'],
  // The freight reached a terminal's dock, at the origin or on the way.
  ['dock', 'in_transit'],
  // The shipment went on the delivering terminal's delivery manifest.
  ['del mfst', 'out_for_delivery'],
]);

// The status line of a delivered shipment: "DELIVERED ON 2023-02-17". The parser drops a
// receiver named in it.
const DELIVERED = /^delivered\b/;
// The status line of a shipment handed to a partner carrier for delivery:
// "TENDERED TO <carrier> ON <date> ON THEIR PRO <number>".
const HANDOFF = /^tendered to\b/;

/** The stage the map gives Peninsula's wording, if it knows it. */
export function peninsulaMappedStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  if (DELIVERED.test(normalized)) return 'delivered';
  if (HANDOFF.test(normalized)) return 'in_transit';
  return STAGES.get(normalized);
}

/** Whether a status line hands the shipment to a partner carrier. */
export function isPeninsulaHandoff(wording: string): boolean {
  return HANDOFF.test(normalizeStatusWording(wording));
}

/**
 * A row's or the status line's stage from the map, else from the shared
 * wording rules. Wording neither knows stays without a stage, so it remains
 * visible for review.
 */
export function peninsulaStage(wording: string): ClassifiedWording | null {
  const mapped = peninsulaMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The reply carries wording only; the map leaves none of it out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : peninsulaMappedStage(wording)),
  gaps: [],
};
