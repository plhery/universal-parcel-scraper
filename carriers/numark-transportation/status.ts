import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const STAGES: ReadonlyMap<string, Stage> = new Map(statuses.entries.map(
  (entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage],
));

/**
 * The stage of a status as the trace words it. Wording the map does not know stays without one:
 * the shared wording rules read "pick up" as waiting at a pickup point, which an LTL pickup is not.
 */
export const numarkStage = (wording: string): Stage | undefined => STAGES.get(normalizeStatusWording(wording));

/** The trace gives wording only; the map leaves none of it out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : STAGES.get(wording)),
  gaps: [],
  wholeWording: true,
};
