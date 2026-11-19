import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

type Entry = { code?: string; wording: string; stage?: string; note?: string };

const ENTRIES = statuses.entries as readonly Entry[];
const isSlug = (code: string) => /^[a-z_]+$/.test(code);

/** The tracking page's journey steps, by slug: the stage holds whatever the step's label says. */
const SLUGS = new Map<string, Stage>(ENTRIES.filter((entry) => entry.stage && entry.code && isSlug(entry.code))
  .map((entry) => [entry.code!, entry.stage as Stage]));

/** The history's titles and the order's current status, by wording; their numeric ids are only recorded. */
const WORDINGS = new Map<string, Stage>(ENTRIES.filter((entry) => entry.stage && !(entry.code && isSlug(entry.code)))
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

export function carryBeeStage(code: string | null, wording: string): Stage | undefined {
  if (code && isSlug(code)) return SLUGS.get(code);
  return WORDINGS.get(normalizeStatusWording(wording));
}

export const statusMap: CarrierStatusMap = {
  stage: carryBeeStage,
  // A step's label is not known before it is seen, so a gap names its slug alone.
  gaps: ENTRIES.filter((entry) => !entry.stage).map((entry) => (entry.code && isSlug(entry.code)
    ? { code: entry.code, note: entry.note! } : { wording: normalizeStatusWording(entry.wording), note: entry.note! })),
};
