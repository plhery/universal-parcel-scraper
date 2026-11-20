import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { wording: string; stage: string }

// The route's points and the shipment's state come as wording alone, without a code.
const WORDINGS: ReadonlyMap<string, Stage> = new Map((statuses.entries as Entry[])
  .map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage the map gives a point's or a state's wording. */
export const skifMappedStage = (wording: string): Stage | undefined => WORDINGS.get(normalizeStatusWording(wording));

/** A wording's stage: the map, else the shared wording rules, else nothing. */
export function skifStage(wording: string): ClassifiedWording | null {
  const mapped = skifMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => skifMappedStage(wording),
  gaps: [],
  wholeWording: true,
};
