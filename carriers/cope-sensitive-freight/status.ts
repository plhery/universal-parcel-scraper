import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The stages eSmart's rows name in their last column, which the adapter keeps as the row's code.
const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.code), entry.stage as Stage]));

/** The stage the map gives a row's code, if it knows it. */
export function copeCodeStage(code: string): Stage | undefined {
  return CODED.get(normalizeStatusWording(code));
}

/** A row's stage from its code, else the shared rules on its activity or code, else nothing, which keeps it visible for review. */
export function copeStage(code: string, activity: string): ClassifiedWording | null {
  const mapped = copeCodeStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  for (const wording of [activity, code]) {
    const worded = classifyWording(wording, 'in_transit');
    if (worded.source !== 'none') return worded;
  }
  return null;
}

/** The row's stage column, kept as its code, sets the stage; the activity beside it does not. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? copeCodeStage(code) : undefined),
  gaps: [],
};
