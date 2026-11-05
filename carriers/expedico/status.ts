import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

export function expedicoStage(code: string | null, wording: string): Stage | undefined {
  if (code === 'created') return 'registered';
  if (code === 'delivered') return 'delivered';
  if (code === 'in_hub') return 'in_transit';
  if (code === 'in_transit') return normalizeStatusWording(wording).replace(/^received code:\s*/, '') === 'out for delivery'
    ? 'out_for_delivery' : 'in_transit';
  return undefined;
}

export const statusMap: CarrierStatusMap = { stage: (code, wording) => expedicoStage(code, wording), gaps: [] };
