import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage?: string; readonly unmapped?: boolean; readonly note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * Chengchuang Supply Chain's scans and the delivering network's, which its tracker copies, come in
 * English. Its own carry codes beside the wording, one code for different wordings among them, the
 * copies none, so the wording decides. The map is the wording recorded in `statuses.json`.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.flatMap((entry) => entry.stage
  ? [[normalizeStatusWording(entry.wording), entry.stage as Stage] as const] : []));

/** Records made after the line's warehouse dispatched the parcel: no scan of it, so no stage. */
const GAPS = ENTRIES.filter((entry) => entry.unmapped)
  .map((entry) => ({ wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' }));
const GAP_WORDINGS = new Set(GAPS.map((gap) => gap.wording));

/** The map's stage for a wording, null for one that moves nothing. */
function mappedStage(wording: string): Stage | null | undefined {
  const text = normalizeStatusWording(wording);
  return GAP_WORDINGS.has(text) ? null : WORDINGS.get(text);
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function chengchainStage(wording: string): ClassifiedWording | null {
  const mapped = mappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (mapped === null) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The map reads the scans' wording; a code decides nothing. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => mappedStage(wording) ?? undefined,
  gaps: GAPS,
};
