import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// TAS Courier's statuses, as its voucher search words them, with the stage each means.
const WORDED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .filter((entry) => entry.stage !== undefined).map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

function mapped(_code: string | null, wording: string): Stage | undefined {
  return WORDED.get(normalizeStatusWording(wording));
}

/** A status's stage: the map, else the shared wording rules, else nothing, which keeps it visible for review. */
export function tasStage(wording: string): ClassifiedWording | null {
  const stage = mapped(null, wording);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Statuses have no code; each is staged by its whole wording. */
export const statusMap: CarrierStatusMap = {
  stage: mapped,
  gaps: [],
  wholeWording: true,
};
