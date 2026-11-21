import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// A move's code names it; its wording repeats its time and place, so only the code is read.
const BY_CODE: ReadonlyMap<string, Stage> = new Map(statuses.entries.map(entry => [entry.code, entry.stage as Stage]));

/** The stage of a container's move by CK Line's code for it. */
export const ckLineStage = (code: string): Stage | undefined => BY_CODE.get(code);

export const statusMap: CarrierStatusMap = {
  stage: code => (code ? BY_CODE.get(code) : undefined),
  gaps: [],
};
