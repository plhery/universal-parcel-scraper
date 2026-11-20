import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const stages: ReadonlyMap<string, Stage> = new Map([
  ['0', 'registered'],
  ['2', 'accepted'],
  ['6', 'in_transit'],
  ['7', 'in_transit'],
  ['8', 'in_transit'],
  ['9', 'customs'],
  // A downstream carrier's pickup follows the Chinz linehaul.
  ['GOT', 'in_transit'],
  ['ARRIVAL', 'in_transit'],
  ['DEPARTURE', 'in_transit'],
  ['SENT_SCAN', 'out_for_delivery'],
  ['SIGNED', 'delivered'],
]);

/** Status mapping for scans read by this adapter. */
export const scanStatusMap: CarrierStatusMap = { stage: code => code === null ? undefined : stages.get(code), gaps: [] };
