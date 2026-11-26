import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The keys the tracker gives each scan (`en_name`) and the parcel (`info.status`). A key that names both, such as
// `delivered`, has one stage.
const STAGES: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));

export const sendyStage = (code: string): Stage | undefined => STAGES.get(code);

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? STAGES.get(code) : undefined),
  gaps: [],
};
