import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);

// Its notes on the booked flight name the day by month and ordinal: "Estimated departure is November 22nd". The day
// becomes an ellipsis.
const ESTIMATED_DAY = /^(estimated (?:departure|arrival date) is )[a-z]+ \d{1,2}(?:st|nd|rd|th)$/;
// The flight's landing names the airport: "Arrived at Sample Airport". The name becomes an ellipsis.
const AIRPORT = /^(arrived at )[a-z][a-z .'-]{0,40}( airport)$/;

const key = (wording: string): string => wording.replace(ESTIMATED_DAY, '$1…').replace(AIRPORT, '$1…$2');

/** The stage Qilin's map gives a row, by its `normalizeStatusWording` wording. A row's kind code decides nothing. */
export function qlgjStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(key(wording));
}

/** The English the adapter shows for a row the line words only in Chinese. */
export function qlgjEnglish(_code: string | null, wording: string): string | undefined {
  return WORDINGS.english(wording);
}

/**
 * Whether a row, by its `normalizeStatusWording` wording, is one the map lists without a stage: the booked flight's
 * departure or arrival day, before it flies. A forecast, not a movement, so it keeps the stage of the scan before it.
 */
export const isQlgjFlightNotice = (wording: string): boolean => WORDINGS.unstaged(key(wording));

const FLIGHT_NOTE = "The booked flight's departure or arrival day, before it flies: a forecast, so the parcel keeps the stage of the scan before it.";

export const statusMap: CarrierStatusMap = { stage: qlgjStage, gaps: [],
  gapNote: (_code, wording) => (isQlgjFlightNotice(wording) ? FLIGHT_NOTE : undefined) };

// DHL's sentences the tracker copies on the line into Europe, on DHL's wall clock where it scanned the parcel, most
// without a place, and those from Germany before the parcel leaves for the destination country.
const DHL_SENTENCE = /^(?:the (?:international )?shipment\b|the instruction data for this shipment\b)/i;
const DHL_GERMAN_ROW = /^the instruction data\b|\b(?:of origin|export parcel center|transported to the destination country)\b/i;

/** Whether a row is one the tracker copies from DHL, on DHL's wall clock. */
export const isQlgjDhlRow = (wording: string): boolean => DHL_SENTENCE.test(wording.trim());
/** Whether a DHL row is one from Germany, before the parcel leaves for the destination country. */
export const isQlgjDhlGermanRow = (wording: string): boolean => DHL_GERMAN_ROW.test(wording);
