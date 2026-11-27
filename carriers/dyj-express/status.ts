import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);

/** The stage DYJ Express's map gives a row, by its `normalizeStatusWording` wording. A row's kind code decides nothing. */
export function dyjExpressStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(wording);
}

export const statusMap: CarrierStatusMap = { stage: dyjExpressStage, gaps: [] };
