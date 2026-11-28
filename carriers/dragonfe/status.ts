import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const PLACEHOLDER = /\\\{station\\\}/g;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * DF Logistics' rows are a Chinese wording without a code. The map is the wordings recorded in
 * `statuses.json`, whose `{station}` stands for the warehouse or city the brackets name.
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = statuses.entries.map((entry) => [
  new RegExp(`^${escape(normalizeStatusWording(entry.wording)).replace(PLACEHOLDER, '[^【】]{1,40}')}$`, 'u'),
  entry.stage as Stage,
]);

function mapped(wording: string): Stage | undefined {
  return WORDINGS.find(([pattern]) => pattern.test(wording))?.[1];
}

/** A row's stage by its wording in the map, else by the shared wording rules, or none. */
export function dragonfeStage(description: string): ClassifiedWording | null {
  const stage = mapped(normalizeStatusWording(description));
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => mapped(wording),
  gaps: [],
  wholeWording: true,
};
