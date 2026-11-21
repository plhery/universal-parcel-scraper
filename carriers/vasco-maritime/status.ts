import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/** The tracker's moves in the order a container makes them: each is a field of its row, named by its code. */
export const MOVES: readonly { readonly code: string; readonly wording: string }[] = statuses.entries;
const BY_CODE: ReadonlyMap<string, Stage> = new Map(statuses.entries.map(entry => [entry.code, entry.stage as Stage]));

/** The stage of a container's move by the tracker's field for it. */
export const vascoStage = (code: string): Stage | undefined => BY_CODE.get(code);

export const statusMap: CarrierStatusMap = {
  stage: code => (code ? BY_CODE.get(code) : undefined),
  gaps: [],
};
