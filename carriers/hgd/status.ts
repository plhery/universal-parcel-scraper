import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording?: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/** The rows carry no code, so the map is the wordings recorded in `statuses.json`. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.wording && entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording!), entry.stage as Stage]));

/** A row's stage: its wording in the map, else the shared wording rules, else nothing. */
export function hgdStage(wording: string): ClassifiedWording | null {
  const mapped = WORDINGS.get(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about a row, by its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => WORDINGS.get(normalizeStatusWording(wording)),
  gaps: [],
};
