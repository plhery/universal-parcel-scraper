import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

export const ENTRIES: readonly { readonly code?: string; readonly wording: string; readonly stage: string | null }[] = statuses.entries;
const WORDINGS = statusWordings(statuses.entries);

// The flight rows name a day of the month: "预计5号的航班", "预计7号落地", and the English the adapter shows for them
// its ordinal: "the flight of the 5th", "land on the 7th".
const DAY = /(预计)(\d{1,2})(号)/;
const ORDINAL = /( the )\d{1,2}(?:st|nd|rd|th)$/;

/** The wording a row is listed under: the day a flight row names stands as "…". */
export const ycexKey = (wording: string): string => wording.replace(DAY, '$1…$3').replace(ORDINAL, '$1…');

const ordinal = (day: number): string => {
  const teen = day % 100 >= 11 && day % 100 <= 13;
  return `${day}${teen ? 'th' : ['th', 'st', 'nd', 'rd'][day % 10] ?? 'th'}`;
};

/** The stage YCEX's map gives a row, by its `normalizeStatusWording` wording. A row's kind code decides nothing. */
export function ycexStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(ycexKey(wording));
}

/** The English the adapter shows for a row the platform words only in Chinese, a flight row with its day as an ordinal. */
export function ycexEnglish(_code: string | null, wording: string): string | undefined {
  const english = WORDINGS.english(ycexKey(wording));
  const day = DAY.exec(wording)?.[2];
  return english && day ? english.replace('…', ordinal(Number(day))) : english;
}

export const statusMap: CarrierStatusMap = { stage: ycexStage, gaps: [] };
