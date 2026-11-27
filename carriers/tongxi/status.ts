import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);

// The delivery carrier's failed attempt names its reason in brackets: "… attempt failed [Recipient not at home]".
const FAILED_ATTEMPT = /^(delivery attempt failure your shipment delivery attempt failed) \[[^\]]{1,80}\]$/;

/** The wording a row is listed under: a failed attempt's reason stands as "…". */
const key = (wording: string): string => wording.replace(FAILED_ATTEMPT, '$1 […]');

/** The stage TongXi's map gives a row, by its `normalizeStatusWording` wording. A row's kind code decides nothing. */
export function tongxiStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(key(wording));
}

export const statusMap: CarrierStatusMap = { stage: tongxiStage, gaps: [] };
