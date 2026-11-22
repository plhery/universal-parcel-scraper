import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker's statuses and manifest captions, with the wording the tracking page gives each.
const CODED: ReadonlyMap<string, { stage: Stage; wording: string }> = new Map(statuses.entries
  .map((entry) => [entry.code, { stage: entry.stage as Stage, wording: entry.wording }]));

export const atcStage = (code: string): Stage | undefined => CODED.get(code)?.stage;
export const atcStatusText = (code: string): string | undefined => CODED.get(code)?.wording;

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? CODED.get(code)?.stage : undefined),
  gaps: [],
};
