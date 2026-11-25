import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const STAGES: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage of a GFS Express scan by its `normalizeStatusWording` wording. */
export function gfsStage(wording: string): Stage | undefined {
  return STAGES.get(wording);
}

export const statusMap: CarrierStatusMap = { stage: (_code, wording) => gfsStage(wording), gaps: [], wholeWording: true };
