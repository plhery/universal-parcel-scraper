import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);
// The airport row names the day of the booked flight in both halves.
const FLIGHT_DAY = /^(货物已交机场,预计)\d{1,2}(号的航班 goods delivered to airport, scheduled on flight of the )\d{1,2}(?:st|nd|rd|th)$/;

// So does the export clearance row, in both halves: "等待27号航班起飞 … on flight of the 27th".
const CLEARED_FLIGHT_DAY = /^(报关已放行等待)\d{1,2}(号航班起飞 customs released,awaiting departure on flight of the )\d{1,2}(?:st|nd|rd|th)$/;

// The English row of a booked flight names its day.
const TAKE_OFF_DAY = /^(flight is expected to take off on )[a-z]+ \d{1,2}$/;

// The newer English rows name the flight's days as month.day: "expected to depart on 10.27 and land on 10.27".
const FLIGHT_DATES = /^(the flight is expected to depart on )\d{1,2}\.\d{1,2}( and land on )\d{1,2}\.\d{1,2}$/;
const LANDING_DATE = /^(the flight has departed and is expected to )\d{1,2}\.\d{1,2}( land)$/;

/** The key a row's `normalizeStatusWording` wording is mapped under: a booked flight's day becomes an ellipsis. */
export const jrtScanKey = (wording: string): string => wording.replace(FLIGHT_DAY, '$1…$2…')
  .replace(CLEARED_FLIGHT_DAY, '$1…$2…').replace(TAKE_OFF_DAY, '$1…')
  .replace(FLIGHT_DATES, '$1…$2…').replace(LANDING_DATE, '$1…$2');

/**
 * The stage JRT's map gives a row, by its whole `normalizeStatusWording` wording:
 * JRT's own, or the English the adapter shows for it.
 * A row's kind code, when it has one, groups many wordings and decides nothing.
 */
export function jrtStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(jrtScanKey(wording));
}

/**
 * The English the adapter shows, by a row's `normalizeStatusWording` wording,
 * for a row JRT words only in Chinese, and for the airport row without the
 * flight it books, which is still to come.
 */
export const jrtEnglish = (_code: string | null, wording: string): string | undefined => WORDINGS.english(jrtScanKey(wording));

export const statusMap: CarrierStatusMap = { stage: jrtStage, gaps: [] };
