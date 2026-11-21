import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const BY_CODE: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .flatMap(entry => entry.stage ? [[entry.code, entry.stage as Stage] as const] : []));

/** The stage of a container's move by the tracker's code for it. */
export const romoceanStage = (code: string): Stage | undefined => BY_CODE.get(code);

export const statusMap: CarrierStatusMap = {
  stage: code => (code ? BY_CODE.get(code) : undefined),
  gaps: statuses.entries.flatMap(entry => entry.stage ? [] : [{ code: entry.code, note: entry.note }]),
};
