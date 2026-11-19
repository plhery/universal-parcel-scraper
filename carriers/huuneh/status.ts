import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

// The status names Huuneh's page shows above each scan's note.
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['pick up', 'registered'],
  ['picked up', 'accepted'],
  ['on route', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

export function huunehStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording.replaceAll('_', ' ')));
}

export const statusMap: CarrierStatusMap = { stage: (code, wording) => code ? undefined : huunehStage(wording), gaps: [] };

/** A scan's stage: the map, else the shared wording rules, else none. */
export function scanStage(wording: string): ClassifiedWording | null {
  const mapped = huunehStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}
