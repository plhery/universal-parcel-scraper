import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

export const ENTRIES: readonly { readonly code?: string; readonly wording: string; readonly stage: string | null }[] = statuses.entries;
const WORDINGS = statusWordings(ENTRIES);

/**
 * The stage Jieyi Tongda's map gives a row, by its `normalizeStatusWording` wording. The
 * warehouse's receipt (`ARRIVAL`) and departure (`SHIPMENT`) have wordings of their own, so a kind
 * code decides nothing.
 */
export function jytdStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(wording);
}

/**
 * Whether a row, by its `normalizeStatusWording` wording, is Israel Post's receipt of a manifest,
 * which the map lists without a stage: a notice, not a movement.
 */
export const isJytdNotice = (wording: string): boolean => WORDINGS.unstaged(wording);

const NOTICE_NOTE = 'Israel Post receives a manifest naming the parcel: the parcel keeps the stage of the scan before it.';

export const statusMap: CarrierStatusMap = { stage: jytdStage, gaps: [],
  gapNote: (_code, wording) => (isJytdNotice(wording) ? NOTICE_NOTE : undefined) };
