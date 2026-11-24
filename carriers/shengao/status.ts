import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

export const ENTRIES: readonly { readonly code?: string; readonly wording: string; readonly english?: string; readonly stage: string }[] = statuses.entries;
const WORDINGS = statusWordings(ENTRIES);

/**
 * The stage SHENGAO's map gives a row, by its `normalizeStatusWording` wording: the carrier's own,
 * or the English the adapter shows for it. A row's kind code decides nothing.
 */
export function shengaoStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(wording);
}

/** The English the adapter shows for a row the platform words only in Chinese, by its `normalizeStatusWording` wording. */
export const shengaoEnglish = (_code: string | null, wording: string): string | undefined => WORDINGS.english(wording);

export const statusMap: CarrierStatusMap = { stage: shengaoStage, gaps: [] };
