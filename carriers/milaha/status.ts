import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// A move's name is the whole wording; the shared rules read parcel scans, not a container's moves.
const BY_WORDING: ReadonlyMap<string, Stage> = new Map(statuses.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage of a container's move by its name, or undefined for a name Milaha's map does not know. */
export const milahaStage = (wording: string): Stage | undefined => BY_WORDING.get(normalizeStatusWording(wording));

/** Moves carry no code. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : BY_WORDING.get(wording)),
  gaps: [],
  wholeWording: true,
};
