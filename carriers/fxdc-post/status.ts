import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
const WORDS = new Map<string, Stage>([
  ['aangemeld', 'registered'], ['ontvangen in miami', 'accepted'], ['verzendklaar', 'in_transit'],
  ['onderweg naar bonaire', 'in_transit'], ['ontvangen op bonaire', 'in_transit'],
  ['klaar om af te halen', 'ready_for_pickup'], ['afgehaald', 'delivered'],
]);
export function fxdcPostStage(_code: string | null, wording: string): Stage | undefined { return WORDS.get(normalizeStatusWording(wording)); }
export const statusMap: CarrierStatusMap = { stage: fxdcPostStage, gaps: [] };
