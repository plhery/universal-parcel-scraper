import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

export function cityAirExpressStage(_code: string | null, wording: string): Stage | undefined {
  const text = normalizeStatusWording(wording);
  if (text === 'delivered') return 'delivered';
  if (text === 'job received at belfast depot') return 'accepted';
  if (text === 'data processed at caebfs') return 'registered';
  return undefined;
}

export const statusMap: CarrierStatusMap = { stage: cityAirExpressStage, gaps: [] };
