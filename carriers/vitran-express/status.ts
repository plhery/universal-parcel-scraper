import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap, type IntentionalStatusGap } from '../../core/status/statusMap.js';

/**
 * Vitran's Quick Track page states the current status in words, without a
 * code, and dates the pickup and the delivery. The adapter words the pickup
 * "Picked Up" and the delivery "Delivered", as the status words it.
 */
const WORDINGS: Readonly<Record<string, Stage>> = {
  'picked up': 'accepted',
  'in-transit': 'in_transit',
  delivered: 'delivered',
};

const GAPS: readonly IntentionalStatusGap[] = [
  { wording: 'no shipment history', note: 'Shown under a shipment that has a status but no scans listed yet; not a status.' },
];

/** The stage the map gives a status or milestone, if it knows the wording. */
export function vitranWordingStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return Object.hasOwn(WORDINGS, normalized) ? WORDINGS[normalized] : undefined;
}

/**
 * The stage of a status or milestone: Vitran's wording, then the shared
 * wording rules. A wording neither knows, or one the map leaves out on
 * purpose, stays without a stage.
 */
export function vitranStage(wording: string): ClassifiedWording | null {
  const mapped = vitranWordingStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const normalized = normalizeStatusWording(wording);
  if (GAPS.some((gap) => gap.wording === normalized)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one status, by its wording: Vitran sends no codes. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : vitranWordingStage(wording)),
  gaps: GAPS,
};
