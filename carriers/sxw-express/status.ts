import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { jtMexicoKey } from '../gzyl/jt-mexico-rows.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);

/**
 * The stage SXW Express's map gives a row, by its `normalizeStatusWording` wording: the carrier's
 * own, or the English the adapter shows for it. A row's kind code decides nothing. A row copied from J&T
 * Express Mexico is found with its towns, sites, courier and phone as ellipses.
 */
export function sxwStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(wording) ?? WORDINGS.stage(jtMexicoKey(wording)) ?? (ARRIVAL_NOTICE.test(wording) ? 'in_transit' : undefined);
}

// The partner's notice that a flight brought the parcel, naming the airports or carriers by their codes:
// "XXX-Notification of arrival from XXX". The map holds it as "…-Notification of arrival from …".
const ARRIVAL_NOTICE = /^[a-z0-9]{2,4}-notification of arrival from [a-z0-9]{2,4}$/;

/** The English the adapter shows for a row the platform words only in Chinese, by its `normalizeStatusWording` wording. */
export const sxwEnglish = (_code: string | null, wording: string): string | undefined => WORDINGS.english(wording);

// A row at a place with no words, only a mark such as ".": it moves nothing.
const WORDLESS = /^[^\p{L}\p{N}]*$/u;

// A row the map lists without a stage, such as the recipient's enquiry lodged with the delivering post: it moves nothing.
const GAPS = statuses.entries.flatMap((entry) => (entry.stage ? [] : [{ wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' }]));

export const statusMap: CarrierStatusMap = {
  stage: sxwStage, gaps: GAPS,
  gapNote: (_code, wording) => (WORDLESS.test(wording) ? 'A row without words: the parcel keeps the stage it had.' : undefined),
};
