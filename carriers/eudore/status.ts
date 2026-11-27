import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage: string | null }
const ENTRIES: readonly Entry[] = statuses.entries;
const MAP: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

// The voyage's delay with its new arrival date: "航程延误，ETA延迟至27.JAN".
const DELAYED = /^(航程延误，eta延迟至).+$/;

/** The key a row is listed under: the delayed arrival's date stands as "…". */
const eudoreKey = (wording: string): string => normalizeStatusWording(wording).replace(DELAYED, '$1…');

/** A row's stage from the line's own wordings, else the shared wording rules. */
export function eudoreStage(wording: string): ClassifiedWording | null {
  const stage = MAP.get(eudoreKey(wording));
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => MAP.get(eudoreKey(wording)),
  gaps: [],
};
