import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['label created', 'registered'], ['on the way', 'in_transit'], ['delivered', 'delivered'],
]);
const TRANSIT = ['arrived at wb facility, ', 'departed wb facility, ', 'export scan, ',
  'shipment departed from ukraine:', 'shipment unloaded in poland, preparing for flight:'];

export function westernBidMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return WORDINGS.get(key) ?? (TRANSIT.some(prefix => key.startsWith(prefix)) ? 'in_transit'
    : /^the delivery has been successfully completed\.(?: · .+)?$/.test(key) ? 'delivered' : undefined);
}

export function westernBidStage(wording: string): ClassifiedWording | null {
  const stage = westernBidMappedStage(wording);
  if (stage) return { stage, source: 'carrier_map' };
  const answer = classifyWording(wording, 'in_transit');
  return answer.source === 'none' ? null : answer;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => westernBidMappedStage(wording),
  gaps: [],
};
