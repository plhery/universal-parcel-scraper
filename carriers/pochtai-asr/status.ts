import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const stages = new Map(statuses.entries.map(({ code, stage }) => [code, stage as Stage]));

export function asrStage(code: string): Stage | undefined {
  return stages.get(code);
}

export const statusMap: CarrierStatusMap = { stage: code => code ? asrStage(code) : undefined, gaps: [] };
