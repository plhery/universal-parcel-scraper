import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

export const ENTRIES: readonly { readonly code?: string; readonly wording: string; readonly stage: string | null }[] = statuses.entries;
const WORDINGS = statusWordings(ENTRIES);

// The booked flight's departure names its day: "Estimated flight departure time (ETD: 11：23)". The day becomes an ellipsis.
const ETD = /^(estimated flight departure time \(etd\s*[:：]\s*)[^)]*\)$/;

const key = (wording: string): string => wording.replace(ETD, '$1…)');

/** The stage ED POST's map gives a row, by its `normalizeStatusWording` wording. A row's kind code decides nothing. */
export function edPostStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(key(wording));
}

/** The English the adapter shows for a row the forwarder words only in Chinese. */
export function edPostEnglish(_code: string | null, wording: string): string | undefined {
  return WORDINGS.english(wording);
}

/**
 * Whether a row, by its `normalizeStatusWording` wording, is one the map lists without a stage: the booked flight's
 * departure, or the recipient's choice of a neighbour DHL may leave the parcel with. Neither moves the parcel, so it
 * keeps the stage of the scan before it.
 */
export const isEdPostNotice = (wording: string): boolean => WORDINGS.unstaged(key(wording));

const NOTICE_NOTE = 'A forecast or a delivery preference, not a movement: the parcel keeps the stage of the scan before it.';

export const statusMap: CarrierStatusMap = { stage: edPostStage, gaps: [],
  gapNote: (_code, wording) => (isEdPostNotice(wording) ? NOTICE_NOTE : undefined) };

// DHL's sentences the tracker copies on the line into Germany, on DHL's wall clock, and those from Germany before
// the parcel leaves for another destination country.
const DHL_SENTENCE = /^(?:the (?:international )?shipment\b|the instruction data for this shipment\b|a preferred neighbour was designated\b)/i;
const DHL_GERMAN_ROW = /^the instruction data\b|\b(?:of origin|export parcel center|transported to the destination country)\b/i;
// GOFO's label row the tracker copies on the line into the Netherlands, on GOFO's wall clock.
const GOFO_ROW = /^shipment not yet received or processed$/i;

/** Whether a row is one the tracker copies from DHL, on DHL's wall clock. */
export const isEdPostDhlRow = (wording: string): boolean => DHL_SENTENCE.test(wording.trim());
/** Whether a DHL row is one from Germany, before the parcel leaves for the destination country. */
export const isEdPostDhlGermanRow = (wording: string): boolean => DHL_GERMAN_ROW.test(wording);
/** Whether a row is one the tracker copies from the delivery carrier, on that carrier's wall clock. */
export const isEdPostCopiedRow = (wording: string): boolean => isEdPostDhlRow(wording) || GOFO_ROW.test(wording.trim());
