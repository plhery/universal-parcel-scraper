import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// A row in Chinese and then the same in English, after a slash or in 【】: "航班抵达【Flight arrival】".
const BILINGUAL = /^([^a-z【】/]*\p{Script=Han}[^a-z【】/]*)(?:\/([^\p{Script=Han}【】/]*[a-z][^\p{Script=Han}【】/]*)|【([^\p{Script=Han}【】]*[a-z][^\p{Script=Han}【】]*)】)$/iu;

/** The English half of a row Lingdong International words in Chinese and then in English, which the adapter shows. */
export function lingdongEnglish(wording: string): string | undefined {
  const match = BILINGUAL.exec(wording.trim());
  return match ? (match[2] ?? match[3])!.trim() : undefined;
}

// Each wording, and the English half of a row in both languages, which the map reads as the whole row.
const WORDINGS = new Map<string, Stage>(statuses.entries.flatMap((entry) => {
  const english = lingdongEnglish(entry.wording);
  return [entry.wording, ...(english ? [english] : [])].map((wording) => [normalizeStatusWording(wording), entry.stage as Stage] as const);
}));
// The booked flight's day, as month.day and in English, "预计10.28航班/Flight scheduled for October 28th" or
// "预计11.9航班/Scheduled flight on November 9st", or as the day of the month in both, "预计30号航班【Expect flight 30th.】".
const FLIGHT_DAY = /^(预计)\d{1,2}\.\d{1,2}(航班\/(?:flight scheduled for|scheduled flight on) )[a-z]+ \d{1,2}(?:st|nd|rd|th)$/;
const FLIGHT_DATE = /^(预计)\d{1,2}(号航班【expect flight )\d{1,2}(?:st|nd|rd|th)(\.?】)$/;
// The same days in the English halves shown alone.
const ENGLISH_FLIGHT_DAY = /^((?:flight scheduled for|scheduled flight on|expected flight on) )[a-z]+\.? \d{1,2}(?:st|nd|rd|th)$/;
const ENGLISH_FLIGHT_DATE = /^(expect flight )\d{1,2}(?:st|nd|rd|th)(\.?)$/;

const FLIGHT_BOOKED = [FLIGHT_DAY, FLIGHT_DATE, ENGLISH_FLIGHT_DAY, ENGLISH_FLIGHT_DATE];

/** Whether a row, whole or by its English half, is the flight booked for the parcel before it flies: a forecast. */
export function isLingdongFlightBooked(wording: string): boolean {
  const english = lingdongEnglish(wording);
  return [wording, ...(english === undefined ? [] : [english])]
    .some((value) => FLIGHT_BOOKED.some((pattern) => pattern.test(normalizeStatusWording(value))));
}

function mapped(wording: string): Stage | undefined {
  return WORDINGS.get(wording.replace(FLIGHT_DAY, '$1…$2…').replace(FLIGHT_DATE, '$1…$2…$3')
    .replace(ENGLISH_FLIGHT_DAY, '$1…').replace(ENGLISH_FLIGHT_DATE, '$1…$2'));
}

/**
 * The stage Lingdong International's map gives a row, by its `normalizeStatusWording` wording or
 * the English half shown for it, with a booked flight's day read as an ellipsis. A row in both
 * languages that the map lacks whole is read by its English half.
 * A row's kind code, when it has one, groups many wordings and decides nothing.
 */
export function lingdongStage(_code: string | null, wording: string): Stage | undefined {
  const english = lingdongEnglish(wording);
  return mapped(wording) ?? (english === undefined ? undefined : mapped(english));
}

export const statusMap: CarrierStatusMap = { stage: lingdongStage, gaps: [] };
