import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);

// Rows the line copies from abroad name the airport or warehouse, and the flight row its landing day.
const AIRPORT = /^(arrived at us )[a-z]{2} .{1,80}( airport)$/;
const WAREHOUSE = /^(your item arrived at us )[a-z]{2} .{1,80}( warehouse)$/;
const FLIGHT = /^(航班起飞，预计航班落地时间)\((\d{1,2}\.\d{1,2})\)$/;

/** The wording a row is listed under: the place or the day a row names stands as "…". */
export const fsqhKey = (wording: string): string => wording
  .replace(AIRPORT, '$1…$2').replace(WAREHOUSE, '$1…$2').replace(FLIGHT, '$1(…)');

/** The stage FSQH's map gives a row, by its `normalizeStatusWording` wording. A row's kind code decides nothing. */
export function fsqhStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(fsqhKey(wording));
}

/** The English the adapter shows for a row the line words only in Chinese, the flight row with its landing day. */
export function fsqhEnglish(_code: string | null, wording: string): string | undefined {
  const day = FLIGHT.exec(wording)?.[2];
  return day ? `Flight departed, expected to land on ${day}` : WORDINGS.english(fsqhKey(wording));
}

export const statusMap: CarrierStatusMap = { stage: fsqhStage, gaps: [] };
