import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// SMT's trace rows and status lines, by their whole wording.
const STAGES: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

function mapped(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/** A row's or status line's stage: the map, else the shared wording rules, else none, which keeps it visible for review. */
export function smtStage(wording: string): ClassifiedWording | null {
  const stage = mapped(wording);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Rows and status lines are staged by their whole English wording; SMT gives no codes. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => mapped(wording),
  gaps: [],
  wholeWording: true,
};
