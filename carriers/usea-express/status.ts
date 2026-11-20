import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const stages = new Map(statuses.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

export function stageOf(wording: string): Stage | undefined {
  return stages.get(normalizeStatusWording(wording));
}

/** A scan's stage: the map, else the shared wording rules, else none. */
export function scanStage(wording: string): ClassifiedWording | null {
  const mapped = stageOf(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The map reads a scan's wording. The shared wording rules are not the carrier's map. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => stageOf(wording),
  gaps: [],
};
