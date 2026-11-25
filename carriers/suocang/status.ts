import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

export const ENTRIES: readonly { readonly code?: string; readonly wording: string; readonly stage: string | null }[] = statuses.entries;
const WORDINGS = statusWordings(ENTRIES);

/**
 * The stage Suoexpress's map gives a row, by its `normalizeStatusWording` wording. The platform's
 * scripted rows (`CO_C_CR`) and the warehouse's (`ARRIVAL`, `SHIPMENT`) share no wording with the
 * rest, so a kind code decides nothing.
 */
export function suocangStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(wording);
}

export const statusMap: CarrierStatusMap = { stage: suocangStage, gaps: [] };
