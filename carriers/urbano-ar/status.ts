import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Urbano's scan codes, with the stage each means.
const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));
// The same scans' wordings, whole, for a scan that comes without its code.
const WORDED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

function mapped(code: string | null, wording: string): Stage | undefined {
  return code === null ? WORDED.get(normalizeStatusWording(wording)) : CODED.get(code.toUpperCase());
}

/** A scan's stage by its code, else the shared rules on its wording, else nothing, which keeps it visible for review. */
export function urbanoStage(code: string | null, wording: string): ClassifiedWording | null {
  const stage = mapped(code, wording);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Scans are staged by Urbano's two-letter code; one without a code by its whole wording. */
export const statusMap: CarrierStatusMap = {
  stage: mapped,
  gaps: [],
  wholeWording: true,
};
