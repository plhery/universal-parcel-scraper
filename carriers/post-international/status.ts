import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const stages = new Map(statuses.entries.map(({ wording, stage }) => [normalizeStatusWording(wording), stage as Stage]));

/** The stage of a history row's status, as recorded in `statuses.json`. */
export function postInternationalStage(wording: string): Stage | undefined {
  return stages.get(normalizeStatusWording(wording));
}

export const statusMap: CarrierStatusMap = { stage: (_code, wording) => postInternationalStage(wording), gaps: [], wholeWording: true };
