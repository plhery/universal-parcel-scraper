import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const stages = new Map(statuses.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

export function stageForWording(wording: string): Stage | undefined {
  return stages.get(wording);
}

/** The map reads a scan's wording, which comes without a code. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => stageForWording(wording),
  gaps: [],
};
