import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);

// The declaration for the crossing into Hong Kong names its batch ahead, by day and letter: "10.7B，申报过港中". The
// batch becomes an ellipsis, and the English leaves it out.
const BATCH = /^[0-9a-z][0-9a-z.\-/]{0,15}，(申报过港中)$/;
// The note on the booked flight names its day of the month: "预计13号的航班". The day becomes an ellipsis, in the
// Chinese and in the English that shows it as an ordinal.
const FLIGHT_DAY = /^(预计)(\d{1,2})(号的航班)$/;
const FLIGHT_DAY_ENGLISH = /^(expected on the flight of the )\d{1,2}(?:st|nd|rd|th)$/;

/** The wording a row is listed under: a batch or a day stands as "…". */
const key = (wording: string): string => wording.replace(BATCH, '…，$1').replace(FLIGHT_DAY, '$1…$3').replace(FLIGHT_DAY_ENGLISH, '$1…');

const ordinal = (day: number): string => {
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return `${day}${suffix}`;
};

/** The stage Anhua's map gives a row, by its `normalizeStatusWording` wording. A row's kind code decides nothing. */
export function anhuaStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(key(wording));
}

/** The English the adapter shows for a row the line words only in Chinese, with the booked flight's day. */
export function anhuaEnglish(_code: string | null, wording: string): string | undefined {
  const day = FLIGHT_DAY.exec(wording)?.[2];
  const english = WORDINGS.english(key(wording));
  return day && english ? english.replace('…', ordinal(Number(day))) : english;
}

/**
 * Whether a row, by its `normalizeStatusWording` wording, is one the map lists without a stage: the day of the flight
 * booked for the parcel, or Australia Post's approval of the shipment's data, while the parcel waits for its flight.
 * Neither moves the parcel, so it keeps the stage of the scan before it.
 */
export const isAnhuaNotice = (wording: string): boolean => WORDINGS.unstaged(key(wording));

// Why each wording listed without a stage has none, by its wording and its English.
const NOTES = new Map(statuses.entries.filter((entry) => entry.stage === null).flatMap((entry) =>
  [entry.wording, ...(entry.english ? [entry.english] : [])].map((wording) => [normalizeStatusWording(wording), entry.note] as const)));

export const statusMap: CarrierStatusMap = { stage: anhuaStage, gaps: [], gapNote: (_code, wording) => NOTES.get(key(wording)) };
