import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The statuses the tracker's rows name before their remark, which the adapter keeps as the row's code.
const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.code), entry.stage as Stage]));

/** The stage the map gives a status, if it knows it. */
export function cityMailCodeStage(code: string): Stage | undefined {
  return CODED.get(normalizeStatusWording(code));
}

/** A row's stage from its status, else the shared wording rules, else nothing, which keeps it visible for review. */
export function cityMailStage(status: string): ClassifiedWording | null {
  const mapped = cityMailCodeStage(status);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(status, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The status, kept as the row's code, sets the stage; the remark after it does not. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? cityMailCodeStage(code) : undefined),
  gaps: [],
};
