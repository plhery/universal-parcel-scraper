import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * Fastgo's scans are a Chinese text without a code. The map is the texts recorded in
 * `statuses.json`; a text it does not know goes through the shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** A scan's stage by its text in the map, else by the shared wording rules, or none. */
export function fastgoStage(description: string): ClassifiedWording | null {
  const mapped = WORDINGS.get(normalizeStatusWording(description));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => WORDINGS.get(wording),
  gaps: [],
  wholeWording: true,
};
