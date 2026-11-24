import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);

/**
 * The stage VYANG's map gives a row, by its `normalizeStatusWording` wording. The warehouse's
 * kind codes (`ARRIVAL`, `SHIPMENT`) come with wordings of their own, so a code decides nothing.
 */
export function vyangStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(wording);
}

export const statusMap: CarrierStatusMap = { stage: vyangStage, gaps: [] };

// DHL's sentences the tracker copies on the line into Germany, on DHL's wall clock where it scanned the parcel, and
// those from Germany before the parcel leaves for another destination country.
const DHL_SENTENCE = /^(?:the (?:international )?shipment\b|(?:un)?loaded (?:to|from) movement \/ tour vehicle\b)/i;
const DHL_GERMAN_ROW = /^the instruction data\b|\b(?:of origin|export parcel center|transported to the destination country)\b/i;

/** Whether a row is one the tracker copies from DHL, on DHL's wall clock. */
export const isVyangDhlRow = (wording: string): boolean => DHL_SENTENCE.test(wording.trim());
/** Whether a DHL row is one from Germany, before the parcel leaves for the destination country. */
export const isVyangDhlGermanRow = (wording: string): boolean => DHL_GERMAN_ROW.test(wording);
