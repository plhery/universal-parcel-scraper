import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Recíbelo's statuses, whole: the tracking page's steps and the ones it hides.
const WORDED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** A status's stage by its whole wording, or nothing, which keeps it visible for review. */
export function recibeloStage(wording: string): Stage | undefined {
  return WORDED.get(normalizeStatusWording(wording));
}

/** The tracker sends no codes; each status is staged by its whole wording. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => recibeloStage(wording),
  gaps: [],
  wholeWording: true,
};
