import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * Garudavega's scan wording, which comes without codes, by its `normalizeStatusWording`
 * form. "SHIPMENT RECEIVED" repeats at the hubs after the booking branch has sorted and
 * manifested the parcel, so it reads as transit, not as the acceptance.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(statuses.entries.map(({ wording, stage }) =>
  [normalizeStatusWording(wording), stage as Stage]));

/** The stage Garudavega's map gives a scan's wording. */
export function garudavegaMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function garudavegaStage(wording: string): ClassifiedWording | null {
  const mapped = garudavegaMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => garudavegaMappedStage(wording),
  gaps: [],
};
