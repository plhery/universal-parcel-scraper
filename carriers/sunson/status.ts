import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);

/** The stage Sunson's map gives a row, by its `normalizeStatusWording` wording. A row's kind code decides nothing. */
export function sunsonStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(wording);
}

/** The English the adapter shows for a row the tracker words only in Chinese. */
export function sunsonEnglish(_code: string | null, wording: string): string | undefined {
  return WORDINGS.english(wording);
}

export const statusMap: CarrierStatusMap = { stage: sunsonStage, gaps: [] };
