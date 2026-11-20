import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const wordings: readonly (readonly [RegExp, Stage])[] = [
  [/^shipment deliver(?:ed)? at /, 'delivered'],
  [/^shipment is out for delivery at /, 'out_for_delivery'],
  [/^shipment (?:reached at|moved from|received at) /, 'in_transit'],
  [/^shipment picked at /, 'accepted'],
  [/^shipment booked$/, 'registered'],
];

export function stageForWording(wording: string): Stage | undefined {
  return wordings.find(([pattern]) => pattern.test(wording))?.[1];
}

/** The map reads a scan's wording, which comes without a code. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => stageForWording(wording),
  gaps: [],
};
