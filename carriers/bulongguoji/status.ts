import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

export const ENTRIES: readonly { readonly code?: string; readonly wording: string; readonly stage: string | null }[] = statuses.entries;
const WORDINGS = statusWordings(ENTRIES);

/**
 * The stage BULONGGUOJI's map gives a row, by its `normalizeStatusWording` wording. The line's
 * kind codes (`ARRIVAL`, `CO_C_CR`, `HKC`, `USA`, `USCC`) each come with a wording of their own,
 * so a code decides nothing.
 */
export function bulongguojiStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(wording);
}

export const statusMap: CarrierStatusMap = { stage: bulongguojiStage, gaps: [] };
