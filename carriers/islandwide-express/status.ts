import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker's state ids, which every scan carries as its Status and the shipment as its
// TrackingStateId. The wording beside one is display text and is not read.
const CODED: ReadonlyMap<string, { stage: Stage; wording: string }> = new Map(statuses.entries
  .map((entry) => [entry.code, { stage: entry.stage as Stage, wording: entry.wording }]));

/** The stage the map gives a state id. */
export const islandwideCodeStage = (code: string): Stage | undefined => CODED.get(code)?.stage;
/** The wording recorded for a state id. */
export const islandwideStatusText = (code: string): string | undefined => CODED.get(code)?.wording;

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? CODED.get(code)?.stage : undefined),
  gaps: [],
};
