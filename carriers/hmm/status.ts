import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { wording: string; stage?: string; note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

// The reply names each move by its wording alone.
const BY_WORDING: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter(entry => entry.stage)
  .map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage of a move by HMM's wording for it. */
export const hmmStage = (wording: string): Stage | undefined => BY_WORDING.get(normalizeStatusWording(wording));

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => BY_WORDING.get(normalizeStatusWording(wording)),
  gaps: ENTRIES.filter(entry => !entry.stage).map(entry => ({ wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' })),
};
