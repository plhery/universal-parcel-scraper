import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

export const ENTRIES: readonly { readonly code?: string; readonly wording: string; readonly stage: string | null }[] = statuses.entries;
const WORDINGS = statusWordings(ENTRIES);

/**
 * The stage MEITONGDA's map gives a row, by its `normalizeStatusWording` wording. The rows carry no
 * kind code. The map lists the line's wording as the tracker gives it, which drops every lower-case
 * "g" ("Packa ed").
 */
export function meitongdaStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(wording);
}

export const statusMap: CarrierStatusMap = { stage: meitongdaStage, gaps: [] };
