import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const stages = new Map(statuses.entries.map(entry => [entry.code, entry.stage as Stage]));

export function stageForCode(code: string): Stage | undefined {
  return stages.get(code);
}

/** The map reads a scan's status id. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? stageForCode(code) : undefined),
  gaps: [],
};
