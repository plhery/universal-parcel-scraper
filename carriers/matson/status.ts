import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { code: string; wording: string; stage?: string; note: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * An event's code is its name, which the page pads to a column before what Matson adds. An entry
 * whose wording is its name alone stages the name whatever follows it; the others stage their
 * whole wording.
 */
const BY_NAME: ReadonlyMap<string, Stage> = new Map(ENTRIES
  .filter(entry => entry.stage && entry.wording === entry.code).map(entry => [entry.code, entry.stage as Stage]));
const key = (code: string, wording: string) => `${code}\n${normalizeStatusWording(wording)}`;
const BY_WORDING: ReadonlyMap<string, Stage> = new Map(ENTRIES
  .filter(entry => entry.stage && entry.wording !== entry.code).map(entry => [key(entry.code, entry.wording), entry.stage as Stage]));

/** The stage of an event by its name and whole wording, or none when Matson's map gives it none. */
export function matsonStage(code: string, wording: string): Stage | undefined {
  return BY_WORDING.get(key(code, wording)) ?? BY_NAME.get(code);
}

/** Matson's events carry their name as a code, which the map reads with their wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? matsonStage(code, wording) : undefined,
  gaps: ENTRIES.filter(entry => !entry.stage).map(entry => ({ code: entry.code, wording: normalizeStatusWording(entry.wording), note: entry.note })),
};
