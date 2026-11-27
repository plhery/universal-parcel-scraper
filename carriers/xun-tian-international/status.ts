import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage: string | null; readonly note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;
const MAP: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
const GAPS: ReadonlySet<string> = new Set(ENTRIES.filter((entry) => entry.stage === null)
  .map((entry) => normalizeStatusWording(entry.wording)));

/** A row's stage from the wordings seen on Xun Tian's tenant, else the shared wording rules; none for a gap. */
export function xunTianStage(wording: string): ClassifiedWording | null {
  const key = normalizeStatusWording(wording);
  const stage = MAP.get(key);
  if (stage) return { stage, source: 'carrier_map' };
  if (GAPS.has(key)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => MAP.get(normalizeStatusWording(wording)),
  gaps: ENTRIES.filter((entry) => entry.stage === null)
    .map((entry) => ({ wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' })),
};
