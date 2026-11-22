import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * A scan's step name (`SCANGB_NM`), as the tracking page shows it: the names seen in replies and
 * those the page's script words as a sentence, all in `statuses.json`. The page reads the name,
 * not the code beside it, and so does the map.
 */
const BY_WORDING: ReadonlyMap<string, Stage> = new Map(ENTRIES
  .flatMap((entry) => entry.stage ? [[normalizeStatusWording(entry.wording), entry.stage as Stage] as const] : []));

/** The stage Woori Taekbae's map gives a step name. */
export function wooriMappedStage(wording: string): Stage | undefined {
  return BY_WORDING.get(normalizeStatusWording(wording));
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function wooriStage(wording: string): ClassifiedWording | null {
  const mapped = wooriMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one scan, by its step name, whatever its code. */
export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  stage: (_code, wording) => wooriMappedStage(wording),
  gaps: [],
};
