import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

export function shipglobalUsStage(code: string | null): Stage | undefined {
  const text = code && normalizeStatusWording(code);
  return text === 'delivered' ? 'delivered' : text === 'in transit' ? 'in_transit' : undefined;
}

export const statusMap: CarrierStatusMap = { stage: code => shipglobalUsStage(code), gaps: [] };
