import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const MOVEMENTS = new Set(['300', '400', '420', '500', '700', '800', '1000', '1150']);

export function lmParcelStage(code: string | null, wording: string): Stage | undefined {
  if (code === '100') return 'registered';
  if (code && MOVEMENTS.has(code)) return 'in_transit';
  if (code === '850') return 'customs';
  const text = normalizeStatusWording(wording);
  if (code === '1215') {
    if (text === 'out for delivery') return 'out_for_delivery';
    if (text === 'processing at designated facility') return 'in_transit';
  }
  if (code === '1300' && /^delivered(?:[., ]|$)/.test(text)) return 'delivered';
  return undefined;
}

export const statusMap: CarrierStatusMap = {
  stage: lmParcelStage,
  gaps: [{ code: '430', note: 'Assigning a last-mile reference is administrative and keeps the preceding physical stage.' }],
};
