import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The status codes the tracker's legend explains under its table, with the legend's sentence for each.
const CODED: ReadonlyMap<string, { stage: Stage; wording: string }> = new Map(statuses.entries
  .map((entry) => [entry.code, { stage: entry.stage as Stage, wording: entry.wording }]));

export const danxCodeStage = (code: string): Stage | undefined => CODED.get(code)?.stage;
export const danxStatusText = (code: string): string | undefined => CODED.get(code)?.wording;

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? CODED.get(code)?.stage : undefined),
  gaps: [],
};
