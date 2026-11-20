import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { wording: string; stage?: string; note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

// A move carries no code: its English wording names it, the same in every reply.
const BY_WORDING: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter(entry => entry.stage)
  .map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage of a container's move by its wording, when the wording alone decides it. */
export const hapagStage = (description: string): Stage | undefined => BY_WORDING.get(normalizeStatusWording(description));

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : BY_WORDING.get(wording)),
  gaps: ENTRIES.filter(entry => !entry.stage).map(entry => ({ wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' })),
  wholeWording: true,
};
