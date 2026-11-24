import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// ComOne's scan codes, with the stage each means.
const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));
// The same scans' English wordings, whole, for a copy that comes without the code.
const WORDED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/**
 * The parcel's status codes the tracking page names, with the step it lights and its title there.
 * Its other codes light steps by range, which the scans' codes say better.
 */
const PROGRESS: ReadonlyMap<number, { stage: Stage; label: string }> = new Map([
  [80, { stage: 'out_for_delivery', label: 'Delivering' }],
  [90, { stage: 'delivered', label: 'Delivered' }],
]);

function mapped(code: string | null, wording: string): Stage | undefined {
  return code === null ? WORDED.get(normalizeStatusWording(wording)) : CODED.get(code.toUpperCase());
}

/** A scan's stage by its code, else the shared rules on its wording, else nothing, which keeps it visible for review. */
export function comoneEventStage(code: string | null, wording: string): ClassifiedWording | null {
  const stage = mapped(code, wording);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The step the tracking page shows for a parcel's status code, when it names that code. */
export function comoneProgress(code: number): { stage: Stage; label: string } | undefined {
  return PROGRESS.get(code);
}

/** Scans are staged by ComOne's code; a relayed scan without one by its whole English wording. */
export const statusMap: CarrierStatusMap = {
  stage: mapped,
  gaps: [],
  wholeWording: true,
};
