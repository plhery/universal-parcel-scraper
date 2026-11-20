import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const stages = new Map(statuses.entries.map(row => [row.code, { ...row, stage: row.stage as Stage }]));

export function jomaStatus(code: string) {
  return stages.get(code);
}

export const statusMap: CarrierStatusMap = { stage: code => code ? jomaStatus(code)?.stage : undefined, gaps: [] };
