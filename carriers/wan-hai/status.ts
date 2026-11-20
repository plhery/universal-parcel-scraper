import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

// Wan Hai words each container move in full, as "Outbound Full Container Gate In To Peir/Terminal(Fcl)".
const RULES: readonly [RegExp, Stage][] = [
  [/^empty container released to shipper\b/, 'registered'],
  [/^outbound full container gate in\b/, 'accepted'],
  [/^full container withdrawn by consignee\b/, 'out_for_delivery'],
  [/^empty container discharged from vessel or gate in to\b/, 'delivered'],
  [/\b(?:laden|full)\b.*\b(?:loaded on board|discharged from|move from one pier)\b/, 'in_transit'],
];

/**
 * The stage of a move by its wording. An empty container leaves for the shipper and comes back
 * once unloaded; a full one enters the terminal, is loaded, discharged and moved between
 * terminals, and leaves with the consignee.
 */
export function wanHaiStage(wording: string): Stage | undefined {
  const text = normalizeStatusWording(wording);
  return RULES.find(([pattern]) => pattern.test(text))?.[1];
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => wanHaiStage(wording),
  gaps: [],
};
