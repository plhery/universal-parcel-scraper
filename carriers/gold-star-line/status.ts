import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { wording: string; stage?: string; note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

// An activity carries no code: its English wording names it, the same at every port.
const BY_WORDING: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter(entry => entry.stage)
  .map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/**
 * The stage of an activity by its wording alone. The parser restages the moves an empty container
 * makes before or after the voyage by their place in the cycle.
 */
export const goldStarLineStage = (wording: string): Stage | undefined => BY_WORDING.get(normalizeStatusWording(wording));

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : BY_WORDING.get(wording)),
  gaps: ENTRIES.filter(entry => !entry.stage).map(entry => ({ wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' })),
  wholeWording: true,
};
