import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// The status types of the tracker's rows, which its page shows as their description, with their
// hyphens read as spaces: the library's wording for "MISSED-DELIVERY" has none.
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['PICK UP', 'accepted'],
  ['ACCEPTANCE', 'accepted'],
  ['MANIFESTED', 'in_transit'],
  ['WAYBILLED', 'in_transit'],
  ['INCOMING', 'in_transit'],
  ['DELIVERY', 'out_for_delivery'],
  ['MISSED DELIVERY', 'failed_attempt'],
  ['RECEIVED', 'delivered'],
]);

/** The stage of a status type; undefined for one the map does not know. */
export function twentyOneExpressStage(type: string): Stage | undefined {
  return STAGES.get(type.trim().toUpperCase().replace(/[\s_-]+/g, ' '));
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => twentyOneExpressStage(code ?? wording),
  gaps: [],
};
