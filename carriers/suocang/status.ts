import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

export const ENTRIES: readonly { readonly code?: string; readonly wording: string; readonly stage: string | null }[] = statuses.entries;
const WORDINGS = statusWordings(ENTRIES);

/**
 * The stage Suoexpress's map gives a row, by its `normalizeStatusWording` wording. The platform's
 * scripted rows (`CO_C_CR`) and the warehouse's (`ARRIVAL`, `SHIPMENT`) share no wording with the
 * rest, so a kind code decides nothing.
 */
export function suocangStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(wording);
}

export const statusMap: CarrierStatusMap = { stage: suocangStage, gaps: [] };

// DHL's sentences the tracker copies on the line into Germany, on DHL's wall clock where it scanned the parcel, and
// those from Germany before the parcel leaves for another destination country.
const DHL_SENTENCE = /^(?:the (?:international )?shipment\b|the instruction data for this shipment\b|(?:un)?loaded (?:to|from) movement \/ tour vehicle\b)/i;
const DHL_GERMAN_ROW = /^the instruction data\b|\b(?:of origin|export parcel center|transported to the destination country)\b/i;

/** Whether a row is one the tracker copies from DHL, on DHL's wall clock. */
export const isSuocangDhlRow = (wording: string): boolean => DHL_SENTENCE.test(wording.trim());
/** Whether a DHL row is one from Germany, before the parcel leaves for the destination country. */
export const isSuocangDhlGermanRow = (wording: string): boolean => DHL_GERMAN_ROW.test(wording);
