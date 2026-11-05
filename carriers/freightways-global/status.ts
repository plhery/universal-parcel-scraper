import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const WORDS = new Map<string, Stage>([
  ['delivered', 'delivered'], ['on courier vehicle for delivery', 'out_for_delivery'],
  ['your parcel is in transit to delivery depot', 'in_transit'], ['picked up', 'accepted'],
  ['handed over to final mile carrier.', 'in_transit'], ['customs cleared in nz', 'in_transit'],
  ['tracking number allocated & order ready', 'registered'],
]);
const DATA = /^customs data (?:processed|received)\s*[–—-]\s*shipment on route to destination country$/;
export function freightwaysGlobalStage(_code: string | null, wording: string): Stage | undefined {
  return WORDS.get(normalizeStatusWording(wording));
}
export const statusMap: CarrierStatusMap = { stage: freightwaysGlobalStage, gaps: [],
  gapNote: (_code, wording) => DATA.test(wording) ? 'Customs data processing is administrative and keeps the preceding physical stage.' : undefined };
