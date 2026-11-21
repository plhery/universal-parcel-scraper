import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const BY_CODE: ReadonlyMap<string, Stage> = new Map(statuses.entries.map(entry => [entry.code, entry.stage as Stage] as const));

/** The stage of a scan by the status code the page gives it. */
export const hiTransStage = (code: string): Stage | undefined => BY_CODE.get(code);

export const statusMap: CarrierStatusMap = {
  stage: code => (code ? BY_CODE.get(code) : undefined),
  gaps: [],
};
