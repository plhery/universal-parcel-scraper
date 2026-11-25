import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// BARQ's status codes, as its tracking page's script lists them, with the stage each means.
const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));

/** A log's or the order's stage by its status code; BARQ words each code one way. */
export function barqStage(code: string | null): Stage | undefined {
  return code === null ? undefined : CODED.get(code);
}

/** Logs and the order's status are staged by BARQ's status code. */
export const statusMap: CarrierStatusMap = {
  stage: barqStage,
  gaps: [],
};
