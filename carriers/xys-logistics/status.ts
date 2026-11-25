import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * XYS Logistics's scans come in English, each with a code beside it, the line's own and the
 * milestones it writes for the flight, customs and the delivering network. The wording decides.
 * The map is the wording recorded in `statuses.json`.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

function mappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function xysStage(wording: string): ClassifiedWording | null {
  const mapped = mappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The map reads the scans' wording; a code decides nothing. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => mappedStage(wording),
  gaps: [],
};
