import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The status codes the tracking API gives each row, with the English half of the row's label.
const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));

/** A row's stage by its code in the map, else by the shared rules on its English wording, or none. */
export function inTimeStage(code: string, wording: string): ClassifiedWording | null {
  const stage = CODED.get(code);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? CODED.get(code) : undefined),
  gaps: [],
};
