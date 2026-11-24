import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * Prime Express's scans carry no code: English wording for its own steps,
 * the flight's and the destination's, and the delivering network's own
 * notice in its language. The map is the wording recorded in
 * `statuses.json`.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

// J&T Express Germany's scans, which the tracker copies in German, open with the district in 【】 and name its sites
// in 【】, so each place makes a new wording: emptied of those names, they take their entry.
const BRACKETED = /【[^】]*】/g;

function mappedStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return WORDINGS.get(normalized) ?? (normalized.startsWith('【') ? WORDINGS.get(normalized.replace(BRACKETED, '【】')) : undefined);
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function prdStage(wording: string): ClassifiedWording | null {
  const mapped = mappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The map reads the scans' wording; they carry no code. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => mappedStage(wording),
  gaps: [],
};
