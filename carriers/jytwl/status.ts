import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);

// The flight the parcel is expected to board, its day in Chinese and in English:
// "预计配载航班7月16日,Expected flight on July 16th".
const FLIGHT = /^(预计配载航班)\d{1,2}月\d{1,2}日([,，]\s*expected flight on )[a-z]+ \d{1,2}(?:st|nd|rd|th)?$/;

/** The wording a row is listed under: the expected flight's day stands as "…". */
const jytwlKey = (wording: string): string => wording.replace(FLIGHT, '$1…$2…');

/** Whether a row is the flight the parcel is expected to board: a forecast, not a movement. */
export const isJytwlFlightForecast = (wording: string): boolean => FLIGHT.test(wording);

/** The stage JYTWL's map gives a row, by its `normalizeStatusWording` wording. A row's kind code decides nothing. */
export function jytwlStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(jytwlKey(wording));
}

/** The English the adapter shows for a row the line words only in Chinese. */
export function jytwlEnglish(_code: string | null, wording: string): string | undefined {
  return WORDINGS.english(jytwlKey(wording));
}

const FLIGHT_FORECAST_NOTE = 'The flight the parcel is expected to board, before it flies: a forecast, so the parcel keeps the stage of the scan before it.';

/** The expected flight has no stage of its own: it keeps the one before it. */
export const statusMap: CarrierStatusMap = { stage: jytwlStage, gaps: [],
  gapNote: (_code, wording) => (isJytwlFlightForecast(wording) ? FLIGHT_FORECAST_NOTE : undefined) };
