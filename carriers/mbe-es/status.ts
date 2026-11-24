import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker relays the courier's scans in Spanish and gives no code; the place before the wording moves to the scan's location.
const STAGES = new Map<string, Stage>(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage of a courier's wording the tracker relayed; a wording it never showed has none. */
export function mbeEsStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  stage: (_code, wording) => STAGES.get(wording),
  gaps: [],
};
