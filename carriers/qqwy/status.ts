import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

export const ENTRIES: readonly { readonly code?: string; readonly wording: string; readonly stage: string | null }[] = statuses.entries;
const WORDINGS = statusWordings(ENTRIES);

// SpeedX's delivery names where the parcel was left: "Delivered. Position: Meet customer".
const POSITION = /^(delivered\. position:) \S.*$/;
// UniUni's failed attempt names its reason in brackets: "…, returning to the warehouse. (Business Closed)".
const REASON = /^(failed delivery attempt, returning to the warehouse\.) \(.*\)$/;
// The line's row naming the last-mile carrier's number: "Last mile, tracking number SPX…".
const LAST_MILE = /^(last mile, tracking number) [a-z0-9]{6,40}$/;

// The place, reason or number becomes an ellipsis.
const key = (wording: string): string =>
  wording.replace(POSITION, '$1 …').replace(REASON, '$1 (…)').replace(LAST_MILE, '$1 …');

/**
 * The stage Global Security's map gives a row, by its `normalizeStatusWording` wording. The
 * warehouse's receipt (`ARRIVAL`) has a wording of its own, so a kind code decides nothing.
 */
export function qqwyStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(key(wording));
}

/** The English the adapter shows for a row the line words only in Chinese. */
export function qqwyEnglish(_code: string | null, wording: string): string | undefined {
  return WORDINGS.english(wording);
}

/**
 * Whether a row, by its `normalizeStatusWording` wording, is the line's naming of the last-mile
 * carrier's number, which the map lists without a stage: a notice, not a movement.
 */
export const isQqwyNotice = (wording: string): boolean => WORDINGS.unstaged(key(wording));

const NOTICE_NOTE = 'The line names the last-mile carrier\'s number: the parcel keeps the stage of the scan before it.';

export const statusMap: CarrierStatusMap = { stage: qqwyStage, gaps: [],
  gapNote: (_code, wording) => (isQqwyNotice(wording) ? NOTICE_NOTE : undefined) };
