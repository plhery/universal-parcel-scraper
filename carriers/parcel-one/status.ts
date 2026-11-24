import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * PARCEL.ONE's scans in English, which carry no code: its own steps up to the
 * hub in Pohlheim, then the delivery carrier's scans as PARCEL.ONE relays them.
 * The label PARCEL.ONE creates for the delivery carrier at the hub, after the
 * parcel has arrived there, is in transit, where the shared rules would read it
 * as a registration.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['the shipment has been prepared for transportation by the sender.', 'registered'],
  ['the shipment has been handed over to a carrier and is now on it\'s way to parcel.one.', 'accepted'],
  ['the shipment arrived the p1 hub and is now being handled.', 'in_transit'],
  ['the shipment has been handled.', 'in_transit'],
  ['the shipment arrived at the distribution office.', 'in_transit'],
  ['the shipment is out for delivery and is expected to be delivered today.', 'out_for_delivery'],
  ['the shipment has been delivered to the mailbox of the recipient.', 'delivered'],
]);
// Wordings that carry the delivery carrier's number.
const PATTERNS: readonly (readonly [RegExp, Stage])[] = [
  [/^the shipping label with trackingno [a-z0-9]{4,40} has been created\.$/, 'in_transit'],
  [/^the shipment has left the p1 hub and can be tracked further in the tracking system of the respective carrier using the shipment number [a-z0-9]{4,40}\.$/, 'in_transit'],
];

// The tracker's progress code, which the tracking page's five steps read: TrackProg050, or written
// with two digits. The page's script names only these four; any other is its first step, "Data
// Received", and says nothing the scans do not.
const PROGRESS: ReadonlyMap<string, { stage: Stage; label: string }> = new Map([
  ['20', { stage: 'in_transit', label: 'In Transit' }],
  ['30', { stage: 'in_transit', label: 'Arrived' }],
  ['40', { stage: 'out_for_delivery', label: 'Out for Delivery' }],
  ['50', { stage: 'delivered', label: 'Delivered' }],
]);
const PROGRESS_CODE = /^trackprog0?(\d{2})$/i;

/** The stage PARCEL.ONE's map gives a scan's wording, if it knows it. */
export function parcelOneMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return WORDINGS.get(key) ?? PATTERNS.find(([pattern]) => pattern.test(key))?.[1];
}

/** The stage and the page's English label for a progress code it names. */
export function parcelOneProgress(code: string): { stage: Stage; label: string } | undefined {
  const step = PROGRESS_CODE.exec(code.trim())?.[1];
  return step ? PROGRESS.get(step) : undefined;
}

/**
 * A scan's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function parcelOneStage(wording: string): ClassifiedWording | null {
  const mapped = parcelOneMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Scans carry wording only; the progress code stands for a parcel without scans. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? parcelOneProgress(code)?.stage : parcelOneMappedStage(wording)),
  gaps: [],
  wholeWording: true,
};
