import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// BoxC's event codes, from its API documentation's dictionary, with the stage each means.
const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .filter((entry) => entry.code !== undefined).map((entry) => [entry.code, entry.stage as Stage]));
// The shipment's statuses and the dictionary's event wordings, whole. Each wording names one code,
// and a status shares a wording only with an event of the same stage, so they never disagree.
const WORDED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

function mapped(code: string | null, wording: string): Stage | undefined {
  return code === null ? WORDED.get(normalizeStatusWording(wording)) : CODED.get(code);
}

/** An event's stage by its code, else the shared rules on its wording, else nothing, which keeps it visible for review. */
export function boxcEventStage(code: string | null, wording: string): ClassifiedWording | null {
  const stage = mapped(code, wording);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The shipment's status, such as En Route, by its wording. */
export function boxcStatusStage(wording: string): ClassifiedWording | null {
  return boxcEventStage(null, wording);
}

/** Events are staged by BoxC's code; a status or a relayed event without one by its whole wording. */
export const statusMap: CarrierStatusMap = {
  stage: mapped,
  gaps: [],
  wholeWording: true,
};
