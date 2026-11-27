import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);

// The flight booked for the parcel, with its date as year/month/day: "预配2025/02/12航班", and as the adapter shows it.
const BOOKED = /^(预配)(\d{4}\/\d{1,2}\/\d{1,2})(航班)$/;
const BOOKED_ENGLISH = /^(booked on the flight of )\d{4}\/\d{1,2}\/\d{1,2}$/;

/** The wording a row is listed under: the booked flight's date stands as "…". */
const ljsKey = (wording: string): string => wording.replace(BOOKED, '$1…$3').replace(BOOKED_ENGLISH, '$1…');

/** Whether a row, in the line's Chinese or the English shown for it, is the flight booked for the parcel: a forecast. */
export const isLjsFlightBooking = (wording: string): boolean => BOOKED.test(wording) || BOOKED_ENGLISH.test(wording);

/** The stage LJS's map gives a row, by its `normalizeStatusWording` wording. A row's kind code decides nothing. */
export function ljsStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(ljsKey(wording));
}

/** The English the adapter shows for a row the line words only in Chinese, the booked flight with its date. */
export function ljsEnglish(_code: string | null, wording: string): string | undefined {
  const date = BOOKED.exec(wording)?.[2];
  return date ? `Booked on the flight of ${date}` : WORDINGS.english(ljsKey(wording));
}

const FLIGHT_BOOKED_NOTE = 'The flight booked for the parcel, before it flies: a forecast, so the parcel keeps the stage of the scan before it.';

/** The booked flight has no stage of its own: it keeps the one before it. */
export const statusMap: CarrierStatusMap = { stage: ljsStage, gaps: [],
  gapNote: (_code, wording) => (isLjsFlightBooking(wording) ? FLIGHT_BOOKED_NOTE : undefined) };
