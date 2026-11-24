import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker names each step of an order in Turkish and gives no code.
const STAGES = new Map<string, Stage>(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage of a step the tracker names; a step it does not list has none. */
export function kargolifeStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  stage: (_code, wording) => STAGES.get(wording),
  gaps: [],
};
