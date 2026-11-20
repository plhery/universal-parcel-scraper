import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const wordings: readonly (readonly [RegExp, Stage])[] = [
  [/^delivered at \d{2}:\d{2}:\d{2}\b/, 'delivered'],
  [/^shipment out for delivery$/, 'out_for_delivery'],
  [/^arrived at destination$|^process for /, 'in_transit'],
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
