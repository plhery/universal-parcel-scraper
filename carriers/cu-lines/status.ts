import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { code: string; wording: string; stage?: string | null; note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

// A move's code is the same whatever its wording, which names the vessel and voyage, and the
// container list words it apart from the move list: the code decides.
const BY_CODE: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter(entry => entry.stage).map(entry => [entry.code, entry.stage as Stage]));

/** The stage of a move by its code, or none for a code the map does not list. */
export const cuLinesStage = (code: string): Stage | undefined => BY_CODE.get(code);

export const statusMap: CarrierStatusMap = {
  stage: code => code ? BY_CODE.get(code) : undefined,
  gaps: ENTRIES.filter(entry => !entry.stage).map(entry => ({ code: entry.code, wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' })),
};
