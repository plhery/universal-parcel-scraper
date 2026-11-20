import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { code: string; wording: string; stage?: string; note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/** An event's matrix id without the count ONE appends to a transshipment's: `E067-02` is `E067`. */
export const matrixKey = (code: string) => code.replace(/-\d{1,2}$/, '');

const BY_CODE: ReadonlyMap<string, Stage> = new Map(ENTRIES
  .filter(entry => entry.stage).map(entry => [matrixKey(entry.code), entry.stage as Stage]));
const BY_WORDING: ReadonlyMap<string, Stage> = new Map(ENTRIES
  .filter(entry => entry.stage).map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage of an event by its matrix id, or none when ONE's map gives it none. */
export function oneStage(code: string): Stage | undefined {
  return BY_CODE.get(matrixKey(code));
}

/** The stage of a container's latest event by its name alone, as the search reply gives it. */
export function oneNamedStage(name: string): Stage | undefined {
  return BY_WORDING.get(normalizeStatusWording(name));
}

/** ONE's events carry their matrix id as a code, which stages them whatever their wording. */
export const statusMap: CarrierStatusMap = {
  codeKey: matrixKey,
  stage: code => code ? oneStage(code) : undefined,
  gaps: ENTRIES.filter(entry => !entry.stage).map(entry => ({ code: matrixKey(entry.code), wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' })),
};
