import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly wording: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/** The reply's `latest_status` codes, as recorded in `statuses.json`. */
const CODES: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.code && entry.stage)
  .map((entry) => [entry.code!, entry.stage as Stage]));
/** The scans, by their whole wording: the last-mile network's, with its name replaced by "carrier". */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => !entry.code && entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

export const coretrailsCodeStage = (code: string): Stage | undefined => CODES.get(code);
export const coretrailsMappedStage = (wording: string): Stage | undefined => WORDINGS.get(normalizeStatusWording(wording));

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function coretrailsStage(wording: string): ClassifiedWording | null {
  const mapped = coretrailsMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODES.get(code) : WORDINGS.get(wording)),
  gaps: [],
};
