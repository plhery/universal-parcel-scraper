import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The status codes of JustShip's tracking history, with the label its tracking page gives each.
const CODED: ReadonlyMap<string, { stage: Stage; wording: string }> = new Map(statuses.entries
  .map((entry) => [entry.code, { stage: entry.stage as Stage, wording: entry.wording }]));

export const justShipStage = (code: string): Stage | undefined => CODED.get(code)?.stage;
export const justShipWording = (code: string): string | undefined => CODED.get(code)?.wording;

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? CODED.get(code)?.stage : undefined),
  gaps: [],
};
