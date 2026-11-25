import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

export const ENTRIES: readonly { readonly code?: string; readonly wording: string; readonly stage: string | null }[] = statuses.entries;
const WORDINGS = statusWordings(ENTRIES);

// The flight rows name their day: "Flight ETD Jun 4.", "The flight has departed Jun 5.". The day becomes an ellipsis.
const FLIGHT_DAY = /^(flight et[ad]|the flight has departed) [a-z]{3,9}\.? \d{1,2}\.?$/;

const key = (wording: string): string => wording.replace(FLIGHT_DAY, '$1 …');

/**
 * The stage ZXSY's map gives a row, by its `normalizeStatusWording` wording. The warehouse's kind
 * codes (`ARRIVAL`, `SHIPMENT`) come with wordings of their own, so a code decides nothing.
 */
export function zxsyStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(key(wording));
}

/** The English the adapter shows for a row the line words in Chinese. */
export function zxsyEnglish(_code: string | null, wording: string): string | undefined {
  return WORDINGS.english(wording);
}

/**
 * Whether a row, by its `normalizeStatusWording` wording, is the booked flight's departure or arrival day,
 * which the map lists without a stage: a forecast, not a movement, so it keeps the stage of the scan before it.
 */
export const isZxsyNotice = (wording: string): boolean => WORDINGS.unstaged(key(wording));

const NOTICE_NOTE = 'A forecast of the booked flight: the parcel keeps the stage of the scan before it.';

export const statusMap: CarrierStatusMap = { stage: zxsyStage, gaps: [],
  gapNote: (_code, wording) => (isZxsyNotice(wording) ? NOTICE_NOTE : undefined) };
