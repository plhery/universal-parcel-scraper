import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Western Post's scan codes and their English wordings, as its tracker gives them.
const CODES = new Map<string, Stage>(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));
const WORDINGS = new Map<string, Stage>(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/**
 * The stage Western Post's map gives a scan: by its code, else by its wording,
 * which a universal provider relays without the code. `wording` is in
 * `normalizeStatusWording` form.
 */
export function westernPostMappedStage(code: string | null, wording: string): Stage | undefined {
  return (code ? CODES.get(code) : undefined) ?? WORDINGS.get(wording);
}

/**
 * A scan's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function westernPostStage(code: string | null, wording: string): ClassifiedWording | null {
  const mapped = westernPostMappedStage(code, normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: westernPostMappedStage,
  gaps: [],
  wholeWording: true,
};
