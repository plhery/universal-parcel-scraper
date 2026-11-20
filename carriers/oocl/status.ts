import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { code: string; wording: string; stage?: string; note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

// A milestone's code is its name and its leg, since a truck's or train's departure means
// something else before the voyage than after it.
const BY_CODE: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter(entry => entry.stage).map(entry => [entry.code, entry.stage as Stage]));

/** The stage of a milestone by its name and leg. */
export const ooclStage = (code: string): Stage | undefined => BY_CODE.get(code);

export const statusMap: CarrierStatusMap = {
  stage: code => code ? BY_CODE.get(code) : undefined,
  gaps: ENTRIES.filter(entry => !entry.stage).map(entry => ({ code: entry.code, wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' })),
  wholeWording: true,
};
