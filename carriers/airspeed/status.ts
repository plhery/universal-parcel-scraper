import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const WORDS = new Map<string, Stage>([
  ['for pick-up', 'registered'], ['picked', 'accepted'],
  ['received at aic whse', 'accepted'], ['delivered', 'delivered'],
]);
export function airspeedStage(_code: string | null, wording: string): Stage | undefined {
  return WORDS.get(normalizeStatusWording(wording));
}
export function isAirspeedAdministrative(wording: string): boolean { return normalizeStatusWording(wording) === 'manifested'; }
export const statusMap: CarrierStatusMap = { stage: airspeedStage, gaps: [],
  gapNote: (_code, wording) => isAirspeedAdministrative(wording) ? 'Manifest preparation records no movement and keeps the preceding custody stage.' : undefined };
