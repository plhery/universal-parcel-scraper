import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const stages: ReadonlyMap<string, Stage> = new Map([
  ['received the order', 'registered'],
  ['booking confirmed', 'registered'],
  ['cargo picked up', 'accepted'],
  ['fcl arrived at port', 'in_transit'],
  ['lcl arrived at cfs', 'in_transit'],
  ['shipped on board', 'in_transit'],
  ['cargo customs cleared', 'in_transit'],
  ['delivery complete', 'delivered'],
]);

export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  gaps: [],
  stage(_code, wording) {
    return stages.get(wording);
  },
};
