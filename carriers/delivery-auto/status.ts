import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const STAGES = new Map(statuses.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage of the receipt's current status. */
export function deliveryStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/** The map reads the receipt's status wording, which comes without a code. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => deliveryStage(wording),
  gaps: [],
};
