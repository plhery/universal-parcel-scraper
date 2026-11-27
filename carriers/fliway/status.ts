import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * A consignment's milestones, by the `trackEvent` code each row carries, with the label the tracker shows for it.
 * The residential milestones that arrange a delivery slot move nothing.
 */
const MILESTONES: ReadonlyMap<string, { stage: Stage; wording: string }> = new Map(statuses.entries
  .filter((entry) => entry.code && entry.stage)
  .map((entry) => [entry.code!, { stage: entry.stage as Stage, wording: entry.wording }]));

/** The stage of a milestone's code. */
export const fliwayMilestoneStage = (code: string): Stage | undefined => MILESTONES.get(code)?.stage;
/** The label the tracker shows for a milestone's code. */
export const fliwayMilestoneText = (code: string): string | undefined => MILESTONES.get(code)?.wording;

/**
 * An item's history rows come without a code: "Picked Up" and the suburb, "Arrived" and the depot,
 * "In Transit", "Out For Delivery", "Delivered".
 */
const ITEM_ROWS: readonly (readonly [RegExp, Stage])[] = [
  [/^picked up\b/i, 'accepted'],
  [/^arrived .{2,60} depot$/i, 'in_transit'],
  [/^in transit\b/i, 'in_transit'],
  [/^out for delivery$/i, 'out_for_delivery'],
  [/^delivered$/i, 'delivered'],
];

/** The stage the map gives an item's row by its wording. */
export function fliwayItemMappedStage(wording: string): Stage | undefined {
  const text = wording.trim().replace(/\s+/g, ' ');
  return ITEM_ROWS.find(([pattern]) => pattern.test(text))?.[1];
}

/** An item row's stage: its wording in the map, else the shared wording rules, else none. */
export function fliwayItemStage(wording: string): ClassifiedWording | null {
  const mapped = fliwayItemMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Milestones carry their code; an item's rows carry wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? fliwayMilestoneStage(code) : fliwayItemMappedStage(wording)),
  gaps: [],
};
