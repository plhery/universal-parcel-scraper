import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

export const ENTRIES: readonly { readonly code?: string; readonly wording: string; readonly stage: string | null }[] = statuses.entries;
const WORDINGS = statusWordings(ENTRIES);

/**
 * The stage Shilianxin's map gives a row, by its `normalizeStatusWording` wording: the English half
 * of a row worded in both languages. The warehouse's receipt (`ARRIVAL`) has a wording of its own,
 * so a kind code decides nothing.
 */
export function shilianxinStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(wording);
}

/** The English the adapter shows for a row the forwarder words only in Chinese. */
export function shilianxinEnglish(_code: string | null, wording: string): string | undefined {
  return WORDINGS.english(wording);
}

export const statusMap: CarrierStatusMap = { stage: shilianxinStage, gaps: [] };
