import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker's event codes, and the wording of its milestones and of a job's own status.
const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .filter((entry) => entry.code).map((entry) => [entry.code!, entry.stage as Stage]));
const WORDED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage of an event by its code, else by its milestone's wording; a job's status by its wording. */
export const boothsStage = (code: string | null, wording: string): Stage | undefined =>
  (code ? CODED.get(code) : undefined) ?? WORDED.get(normalizeStatusWording(wording));

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => boothsStage(code, wording),
  gaps: [],
  wholeWording: true,
};
