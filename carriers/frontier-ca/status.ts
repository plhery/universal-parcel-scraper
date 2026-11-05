import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
const WORDS = new Map<string, Stage>([
  ['delivered', 'delivered'], ['out for delivery', 'out_for_delivery'], ['picked up', 'accepted'],
  ['pickup dispatched to driver', 'registered'], ['pickup request received', 'registered'],
  ['in transit', 'in_transit'], ['returned', 'returned'], ['exception', 'exception'],
]);
export function frontierCaStage(code: string | null, wording: string): Stage | undefined {
  const text = normalizeStatusWording(wording);
  if (code === '80') return text === 'delivered' ? 'delivered' : undefined;
  if (code && normalizeStatusWording(code) !== text) return undefined;
  return WORDS.get(text);
}
export const statusMap: CarrierStatusMap = { stage: frontierCaStage, gaps: [] };
