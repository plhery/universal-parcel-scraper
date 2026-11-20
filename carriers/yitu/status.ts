import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly wording?: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * YITU's first scans carry a code, whatever their wording; its later scans
 * come in Chinese without one, and the delivering carrier's in English. The
 * map is the codes and wordings recorded in `statuses.json`.
 */
const CODES: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.code && entry.stage)
  .map((entry) => [entry.code!, entry.stage as Stage]));
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => !entry.code && entry.wording && entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording!), entry.stage as Stage]));

/** A scan's stage: its code, else its wording in the map, else the shared wording rules, else nothing. */
export function yituStage(wording: string, code = ''): ClassifiedWording | null {
  const mapped = (code ? CODES.get(code) : undefined) ?? WORDINGS.get(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about a scan, by its code, else by its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODES.get(code) : undefined) ?? WORDINGS.get(normalizeStatusWording(wording)),
  gaps: [],
};
