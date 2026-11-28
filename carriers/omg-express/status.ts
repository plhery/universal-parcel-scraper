import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * OMG's timeline gives each scan a status code beside a Chinese label. The codes recorded in
 * `statuses.json` carry one stage whatever their label, so the map reads the code alone.
 */
const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));

export const omgExpressCodeStage = (code: string): Stage | undefined => CODED.get(code);

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? CODED.get(code) : undefined),
  gaps: [{
    code: 'UNKNOWN',
    note: 'OMG labels it 状态未知 (status unknown); the public example gives it to the order payment at the US warehouse, which moves nothing.',
  }],
};
