import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

export const ENTRIES: readonly { readonly code?: string; readonly wording: string; readonly stage: string | null }[] = statuses.entries;
const WORDINGS = statusWordings(ENTRIES);

/**
 * The stage Xinshu Logistics's map gives a row, by its `normalizeStatusWording` wording. The line's
 * own rows (`ARRIVAL`, `SHIPMENT`) share no wording with USPS's copies, so a kind code decides nothing.
 */
export function xsExpressStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(wording);
}

export const statusMap: CarrierStatusMap = { stage: xsExpressStage, gaps: [] };
