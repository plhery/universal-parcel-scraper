import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// "Trailer Departed For Seattle": the wording names the terminal the trailer heads to.
const DEPARTED_FOR = /^trailer departed for \S/;
const PLACEHOLDER = '{terminal}';

/**
 * Diamond Line's history rows are a wording without a code. The map is the wordings recorded in
 * `statuses.json`; a departure names its terminal, which `{terminal}` stands for there.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .filter((entry) => !entry.wording.includes(PLACEHOLDER))
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
const DEPARTED_STAGE = statuses.entries.find((entry) => entry.wording.includes(PLACEHOLDER))!.stage as Stage;

function mapped(wording: string): Stage | undefined {
  return WORDINGS.get(wording) ?? (DEPARTED_FOR.test(wording) ? DEPARTED_STAGE : undefined);
}

/** A row's stage by its wording in the map, else by the shared wording rules, or none. */
export function diamondLineStage(description: string): ClassifiedWording | null {
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
