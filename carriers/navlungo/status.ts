import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const stages: ReadonlyMap<string, Stage> = new Map([
  ['1', 'registered'],
  ['2', 'delivered'],
  ['3', 'in_transit'],
  ['4', 'out_for_delivery'],
  ['16', 'accepted'],
  ['17', 'in_transit'],
  ['21', 'exception'],
]);

export const statusMap: CarrierStatusMap = {
  stage(code) {
    return code ? stages.get(code) : undefined;
  },
  gaps: [],
};
