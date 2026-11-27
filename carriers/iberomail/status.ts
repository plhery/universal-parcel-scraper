import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker's rows carry no code: the domestic network's Spanish wording, the English of a partner
// post and Iberomail's own summary steps, each seen whole, with the stage it means.
const WORDED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

function mapped(wording: string): Stage | undefined {
  return WORDED.get(normalizeStatusWording(wording));
}

/** A row's stage from the map, else the shared rules on its wording, else nothing, which keeps it visible for review. */
export function iberomailStage(wording: string): ClassifiedWording | null {
  const stage = mapped(wording);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The map stages wordings whole; it leaves none out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => mapped(wording),
  gaps: [],
  wholeWording: true,
};
