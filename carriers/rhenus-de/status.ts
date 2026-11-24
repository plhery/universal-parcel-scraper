import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/** A code of the portal: its German wording, as the portal shows it, and its stage. */
export interface RhenusDeStatus {
  readonly wording: string;
  readonly stage: Stage;
}

// The steps of the order's tracking (camelCase) and the order's current status (PascalCase), as
// statuses.json records them with the portal's German wording for each.
const BY_CODE: ReadonlyMap<string, RhenusDeStatus> = new Map(statuses.entries
  .map((entry) => [entry.code, { wording: entry.wording, stage: entry.stage as Stage }]));

/** A step's or the order's status by its code. */
export function rhenusDeStatus(code: string): RhenusDeStatus | undefined {
  return BY_CODE.get(code);
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? BY_CODE.get(code)?.stage : undefined),
  gaps: [],
};
