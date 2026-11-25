import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Flip Xpress's status codes, with the stage each means. A code's wordings all share its stage.
const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));
const WORDED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

function mapped(code: string | null, wording: string): Stage | undefined {
  return (code === null ? undefined : CODED.get(code)) ?? WORDED.get(normalizeStatusWording(wording));
}

/** An event's stage by its code, else the shared rules on its wording, else nothing, which keeps it visible for review. */
export function flipEventStage(code: string | null, wording: string): ClassifiedWording | null {
  const stage = mapped(code, wording);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Events are staged by Flip Xpress's status code, else by their whole wording. */
export const statusMap: CarrierStatusMap = {
  stage: mapped,
  gaps: [],
  wholeWording: true,
};
