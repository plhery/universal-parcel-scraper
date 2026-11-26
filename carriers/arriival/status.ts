import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker's numeric scan codes (`orderStatus`) and the stage of each one seen.
const STAGES: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));

export const arriivalStage = (code: string): Stage | undefined => STAGES.get(code);

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? STAGES.get(code) : undefined),
  gaps: [],
};
