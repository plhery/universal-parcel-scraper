import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = new Map<string, Stage>(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
// The US sorting partner's receipt, which names its facility by a code, as `NJC01`.
const FACILITY_RECEIPT = /^parcel received by [a-z]{2,4}\d{1,3}\.?$/;

/**
 * The stage HUA Express's map gives a row, by its `normalizeStatusWording` wording. A
 * receipt at a facility named by its code reads the same whatever the code. The delivering
 * carrier's wordings are left to the shared wording rules.
 */
export function huaExpressStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.get(wording) ?? (FACILITY_RECEIPT.test(wording) ? 'in_transit' : undefined);
}

export const statusMap: CarrierStatusMap = { stage: huaExpressStage, gaps: [] };
