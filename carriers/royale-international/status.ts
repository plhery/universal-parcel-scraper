import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

export function royaleInternationalStage(wording: string): Stage | undefined {
  const text = normalizeStatusWording(wording);
  if (text === 'proof of delivery') return 'delivered';
  if (/^in transit to .+ facility$/.test(text) || /^checked in at .+ facility$/.test(text)) return 'in_transit';
  return undefined;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => royaleInternationalStage(wording),
  gaps: [{ wording: normalizeStatusWording('POD Details Captured'),
    note: 'Capturing proof is an administrative update; the dated proof itself establishes delivery.' }],
};
