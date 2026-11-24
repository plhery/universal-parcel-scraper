import { classifyWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// JRS Express's status texts, by wording: its tracker gives no status code.
const WORDINGS = new Map<string, Stage>(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage the map gives a status text, if it knows it. */
export function jrsStatusStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/**
 * A scan's stage from the map, else from the shared wording rules. A wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function jrsStage(wording: string): { stage: Stage; stage_source: string } | undefined {
  const mapped = jrsStatusStage(wording);
  if (mapped) return { stage: mapped, stage_source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? undefined : { stage: worded.stage, stage_source: worded.source };
}

/** The status is wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : jrsStatusStage(wording)),
  gaps: [],
};
