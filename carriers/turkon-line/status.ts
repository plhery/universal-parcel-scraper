import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { code: string; wording: string; stage?: string; note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

// A move's code names it; its wording is the code's English name in either language of the page.
const BY_CODE: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter(entry => entry.stage).map(entry => [entry.code, entry.stage as Stage]));

/** The stage of a container's move by Turkon's code for it. */
export const turkonStage = (code: string): Stage | undefined => BY_CODE.get(code);

export const statusMap: CarrierStatusMap = {
  stage: code => code ? BY_CODE.get(code) : undefined,
  gaps: ENTRIES.filter(entry => !entry.stage).map(entry => ({ code: entry.code, wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' })),
};
