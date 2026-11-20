import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { code?: string; wording: string; stage?: string; note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

// The chain's milestones and the vessel legs carry their event's name as a code; the latest
// milestone comes with its wording alone.
const BY_CODE: ReadonlyMap<string, Stage> = new Map(ENTRIES
  .filter(entry => entry.code && entry.stage).map(entry => [entry.code!, entry.stage as Stage]));
const BY_WORDING: ReadonlyMap<string, Stage> = new Map(ENTRIES
  .filter(entry => !entry.code && entry.stage).map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage of a milestone by its code, or by its wording when it came without one. */
export function coscoStage(code: string | null, wording: string): Stage | undefined {
  return code ? BY_CODE.get(code) : BY_WORDING.get(normalizeStatusWording(wording));
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? BY_CODE.get(code) : BY_WORDING.get(wording),
  gaps: ENTRIES.filter(entry => !entry.stage).map(entry => ({ ...(entry.code ? { code: entry.code } : {}),
    wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' })),
  wholeWording: true,
};
