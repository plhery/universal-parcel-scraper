import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

export const ENTRIES: readonly { readonly wording: string; readonly stage: string }[] = statuses.entries;
const WORDINGS = new Map<string, Stage>(ENTRIES.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

// The flight row names the day it is due to land: "航班起飞，预计航班落地时间(10.22)".
const LANDING_DAY = /^(航班起飞[，,] ?预计航班落地时间[(（])\d{1,2}[./]\d{1,2}([)）])$/;

/** The key a row's `normalizeStatusWording` wording is mapped under: the flight's landing day becomes an ellipsis. */
export const huayaScanKey = (wording: string): string => wording.replace(LANDING_DAY, '$1…$2');

/**
 * The stage Huaya Express's map gives a row, by its `normalizeStatusWording` wording.
 * A row's kind code, when it has one, groups many wordings and decides nothing.
 */
export function huayaStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.get(huayaScanKey(wording));
}

// DHL's sentences the tracker copies on the line into Germany, on DHL's wall clock where it scanned the parcel.
const DHL_SENTENCE = /^(?:the (?:international )?shipment\b|the instruction data for this shipment\b|unfortunately\b|the recipient could not be found\b)/i;
// DHL's rows from Germany before the parcel leaves for the destination country, and the shipment announced to it.
const DHL_GERMAN_ROW = /^the instruction data\b|\b(?:of origin|export parcel center|transported to the destination country|in transit to dhl)\b/i;

/** Whether a row is one the tracker copies from DHL, on DHL's wall clock. */
export const isHuayaDhlRow = (wording: string): boolean => DHL_SENTENCE.test(wording.trim());
/** Whether a DHL row is one from Germany, before the parcel leaves for the destination country. */
export const isHuayaDhlGermanRow = (wording: string): boolean => DHL_GERMAN_ROW.test(wording);

// The US delivery partner's rows name the country, the town and the partner's facility: "US, BENSENVILLE, ORD HUB".
// The destination carrier's label row at "US, SYSTEM, SYSTEM" names no town.
const US_PLACE = /^\s*US\s*,(?!\s*SYSTEM\s*,)[^,]*[A-Z][^,]*,/i;
/** Whether a row is the US delivery partner's, at a town in the United States, on that town's wall clock. */
export const isHuayaUsRow = (place: string): boolean => US_PLACE.test(place);

export const statusMap: CarrierStatusMap = { stage: huayaStage, gaps: [] };
