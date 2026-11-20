import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

export type StageOf = (wording: string) => ClassifiedWording | null;

// ParcelPerfect writes the depot into some events, as "Checked in at Durban facility"; the stage does not depend on it.
const DEPOT = /\b(at|to|from) \p{L}[\p{L} .'-]*? facility$/iu;
export const depotless = (wording: string) => normalizeStatusWording(wording.trim().replace(DEPOT, '$1 facility'));

/** A tenant's stages by wording, whatever depot it names, else the shared wording rules, else nothing. */
export function parcelPerfectStages(entries: readonly { wording: string; stage: string }[]): StageOf {
  const stages = new Map(entries.map(entry => [depotless(entry.wording), entry.stage as Stage]));
  return wording => {
    const mapped = stages.get(depotless(wording));
    if (mapped) return { stage: mapped, source: 'carrier_map' };
    const worded = classifyWording(wording, 'in_transit');
    return worded.source === 'none' ? null : worded;
  };
}

/**
 * A tenant's map by wording, without the shared wording rules. The parser also keeps the stage
 * before a capture or a ready-for-collection scan after the parcel has moved, and reads a
 * dispatch after the round has started as the round.
 */
export function parcelPerfectStatusMap(stageOf: StageOf): CarrierStatusMap {
  return {
    stage: (_code, wording) => {
      const staged = stageOf(wording);
      return staged?.source === 'carrier_map' ? staged.stage : undefined;
    },
    gaps: [],
  };
}
