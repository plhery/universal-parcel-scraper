import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

export const ENTRIES: readonly { readonly code?: string; readonly wording: string; readonly stage: string | null }[] = statuses.entries;
const WORDINGS = statusWordings(statuses.entries);

// The platform's rows name the processing centre's city: "到达广州处理中心", "离开霍尔果斯处理中心".
const CENTRE = /^(到达|离开).{1,20}(处理中心)$/;

/** The wording a row is listed under: the processing centre's city stands as "…". */
export const sdkExpressKey = (wording: string): string => wording.replace(CENTRE, '$1…$2');

/**
 * The stage SDK Express's map gives a row, by its `normalizeStatusWording` wording: the carrier's
 * own, in Chinese or Russian, or the English the adapter shows for it. A row's kind code decides nothing.
 */
export function sdkExpressStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(sdkExpressKey(wording));
}

/** The English the adapter shows for a row worded only in Chinese or Russian, by its `normalizeStatusWording` wording. */
export const sdkExpressEnglish = (_code: string | null, wording: string): string | undefined =>
  WORDINGS.english(sdkExpressKey(wording));

export const statusMap: CarrierStatusMap = { stage: sdkExpressStage, gaps: [] };
