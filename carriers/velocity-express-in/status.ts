import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const stages = new Map(statuses.entries.map(entry => [entry.code, entry.stage as Stage]));
const wordings = new Map(statuses.entries.map(entry => [entry.code, entry.wording]));

export function stageOf(code: string): Stage | undefined {
  return stages.get(code);
}

/** The wording Velocity's tracker gives a status code, when it is known. */
export function wordingOf(code: string): string | undefined {
  return wordings.get(code);
}

/** The map reads a scan's status code. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? stageOf(code) : undefined),
  gaps: [],
};
