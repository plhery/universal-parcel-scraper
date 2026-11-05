import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

export function vXpressStage(_code: string | null, wording: string): Stage | undefined {
  const text = normalizeStatusWording(wording);
  if (text === 'delivered' || /^delivered to\s+\S/.test(text)) return 'delivered';
  if (text === 'out for delivery') return 'out_for_delivery';
  if (['all package label generated', 'package labels printed'].includes(text)) return 'registered';
  if (['in transit', 'unloaded at facility', 'arrived at delivery branch', 'loaded for transport'].includes(text)
    || /^unloaded from manifest\s+\S+\s+at\s+\S/.test(text) || /^unloaded at delivery branch\s+\S/.test(text)
    || /^loaded for manifest\s+\S/.test(text)) return 'in_transit';
  return undefined;
}
export const statusMap: CarrierStatusMap = { stage: vXpressStage, gaps: [
  { wording: 'dispatch recorded', note: 'A mobile dispatch entry alone does not establish a physical departure.' },
] };
