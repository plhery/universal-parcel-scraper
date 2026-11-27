import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording?: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;
const MAP: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.wording && entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording!), entry.stage as Stage]));

/** A scan's stage from the wordings seen on U-Speed's tenant, else the shared wording rules. */
export function uSpeedStage(wording: string): ClassifiedWording | null {
  const stage = MAP.get(normalizeStatusWording(wording));
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => MAP.get(normalizeStatusWording(wording)),
  gaps: [],
};
