import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const stages = new Map<string, Stage>(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage of a scan's wording; undefined for wording the tracker has not shown or named. */
export function ctlGroupStage(wording: string): Stage | undefined {
  return stages.get(normalizeStatusWording(wording));
}

/** The tracker gives each scan in words, without a code. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => ctlGroupStage(wording),
  gaps: [],
};
