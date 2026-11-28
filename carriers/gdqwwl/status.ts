import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const PLACEHOLDER = /\\\{place\\\}/g;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Quanwang's rows are a Chinese wording without a code. The map is the wordings recorded in `statuses.json`,
 * whose `{place}` stands for the shipper the freight was taken in from or the city it reached.
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = statuses.entries.map((entry) => [
  new RegExp(`^${escape(normalizeStatusWording(entry.wording)).replace(PLACEHOLDER, '.{1,30}')}$`, 'u'),
  entry.stage as Stage,
]);

function mapped(wording: string): Stage | undefined {
  return WORDINGS.find(([pattern]) => pattern.test(wording))?.[1];
}

/** A row's stage by its wording in the map, else by the shared wording rules, or none. */
export function quanwangStage(description: string): ClassifiedWording | null {
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
