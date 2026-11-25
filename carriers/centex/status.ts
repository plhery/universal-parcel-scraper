import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * CENTEX's scan wording, which comes without codes, by its `normalizeStatusWording` form: its own English rows in
 * China, then the Portuguese rows Correios gives the parcel. Correios records the posting once the flight has left,
 * so "objeto postado" is transit, not the acceptance.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(statuses.entries.map(({ wording, stage }) =>
  [normalizeStatusWording(wording), stage as Stage]));

/** The stage CENTEX's map gives a scan's wording. */
export function centexMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function centexStage(wording: string): ClassifiedWording | null {
  const mapped = centexMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => centexMappedStage(wording),
  gaps: [],
};
