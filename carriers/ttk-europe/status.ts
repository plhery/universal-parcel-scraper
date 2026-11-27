import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/** The English half of each row TTK Europe writes, which has no code, by its stage. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
/** statuses.json lists the wordings in the order of the journey, from the order's entry to the hand-over. */
const JOURNEY: ReadonlyMap<string, number> = new Map(ENTRIES.map((entry, index) => [normalizeStatusWording(entry.wording), index]));

/** A row's stage: the map, else the shared wording rules, else nothing. */
export function ttkEuropeStage(wording: string): ClassifiedWording | null {
  const mapped = WORDINGS.get(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Where a row's wording comes in the journey, or undefined for one the map does not know. */
export const ttkEuropeJourneyStep = (wording: string): number | undefined => JOURNEY.get(normalizeStatusWording(wording));

export const statusMap: CarrierStatusMap = { stage: (code, wording) => (code ? undefined : WORDINGS.get(wording)), gaps: [], wholeWording: true };
