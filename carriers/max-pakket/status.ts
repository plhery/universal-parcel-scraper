import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracking app's milestone summaries and its scan wordings, whole.
const WORDED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

function mapped(_code: string | null, wording: string): Stage | undefined {
  return WORDED.get(normalizeStatusWording(wording));
}

/** A wording's stage from the map, else the shared rules on it, else nothing, which keeps it visible for review. */
export function maxPakketStage(wording: string): ClassifiedWording | null {
  const stage = mapped(null, wording);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Milestones and scans are staged by their whole wording; the tracking app gives them no codes. */
export const statusMap: CarrierStatusMap = {
  stage: mapped,
  gaps: [],
  wholeWording: true,
};
