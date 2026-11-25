import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Premo's event codes, as its tracking page marks each event, with the stage each means.
const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));
// The same events' Swedish headings, whole, for an event that comes without its code.
const WORDED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

function mapped(code: string | null, wording: string): Stage | undefined {
  return code === null ? WORDED.get(normalizeStatusWording(wording)) : CODED.get(code);
}

/** An event's stage by its code, else the shared rules on its heading, else nothing, which keeps it visible for review. */
export function premoEventStage(code: string | null, wording: string): ClassifiedWording | null {
  const stage = mapped(code, wording);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Events are staged by Premo's code; one without a code by its whole Swedish heading. */
export const statusMap: CarrierStatusMap = {
  stage: mapped,
  gaps: [],
  wholeWording: true,
};
