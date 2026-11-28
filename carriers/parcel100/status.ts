/**
 * Parcel100's own rows carry a status code; `statuses.json` gives each code's stage and the
 * wording the tracker shows with it. An entry marked `unmapped` is a notice the map leaves
 * without a stage on purpose. Rows Parcel100 relays from the courier in China carry code 0 and
 * the courier's own wording, which the parser reads by the shared wording rules.
 */
import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code: string; readonly wording: string; readonly stage?: string; readonly unmapped?: boolean; readonly note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

const CODED: ReadonlyMap<string, Stage> = new Map(ENTRIES.flatMap((entry) => (entry.stage ? [[entry.code, entry.stage as Stage] as const] : [])));

/** A Parcel100 status code's stage, or undefined for a notice or a code the map has not seen. */
export const parcel100CodeStage = (code: string): Stage | undefined => CODED.get(code);

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? CODED.get(code) : undefined),
  gaps: ENTRIES.flatMap((entry) => (entry.unmapped ? [{ code: entry.code, note: entry.note ?? '' }] : [])),
};
