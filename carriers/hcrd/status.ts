import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

export const ENTRIES: readonly { readonly code?: string; readonly wording: string; readonly stage: string | null }[] = statuses.entries;
const WORDINGS = new Map<string, Stage>(ENTRIES.filter((entry) => entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
// The hand-over to GOFO, which names GOFO's number.
const HAND_OFF = /^in transit via gofo tracking number\s*[:：]\s*[a-z0-9]{6,40}$/;

/**
 * The stage HCRD's map gives a row, by its `normalizeStatusWording` wording; the hand-over to GOFO
 * reads the same whatever number it names. The platform's scripted rows (`CO_C_CR`) share their
 * wordings with nothing else the tracker writes, so the kind code decides nothing.
 */
export function hcrdStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.get(wording) ?? (HAND_OFF.test(wording) ? 'in_transit' : undefined);
}

export const statusMap: CarrierStatusMap = {
  stage: hcrdStage,
  gaps: [{ wording: 'fedex', note: 'A row that names the line’s delivering carrier, without a movement or a number.' }],
};
