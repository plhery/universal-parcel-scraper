import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Afimex's scan wordings, whole, with the stage each means.
const STAGES: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

function mapped(_code: string | null, wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/** A scan's stage by its whole wording, else the shared rules on it, else nothing, which keeps it visible for review. */
export function afimexStage(wording: string): ClassifiedWording | null {
  const stage = mapped(null, wording);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Scans come without a code; they are staged by their whole wording. */
export const statusMap: CarrierStatusMap = {
  stage: mapped,
  gaps: [],
  wholeWording: true,
};
