import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The rows' steps, whole, with the stage each means. COSHIP's own rows carry codes, but the
// rows it relays from Korean customs and Korea Post share its code field, so the step decides.
const WORDED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

function mapped(_code: string | null, wording: string): Stage | undefined {
  return WORDED.get(normalizeStatusWording(wording));
}

/** A row's stage by its whole step, else the shared rules on its wording, else nothing, which keeps it visible for review. */
export function coshipEventStage(code: string | null, wording: string): ClassifiedWording | null {
  const stage = mapped(code, wording);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Rows are staged by their whole step, in Korean or English. */
export const statusMap: CarrierStatusMap = {
  stage: mapped,
  gaps: [],
  wholeWording: true,
};
