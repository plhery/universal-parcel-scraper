/**
 * Zhuanshunda's rows: a text without a code, in Chinese, some followed by the same in English. A text the map
 * does not know goes through the shared wording rules.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const STAGES: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => STAGES.get(wording),
  gaps: [],
  wholeWording: true,
};

/** A row's stage, by its text in `statuses.json`, else by the shared wording rules, or none. */
export function zsda56Stage(description: string): ClassifiedWording | null {
  const stage = STAGES.get(normalizeStatusWording(description));
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source !== 'none' ? worded : null;
}
