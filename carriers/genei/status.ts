import type { Stage } from '../../core/status/index.js';
import { type CarrierStatusMap } from '../../core/status/statusMap.js';

const stages: ReadonlyMap<string, Stage> = new Map([
  ['3', 'delivered'],
  ['5', 'in_transit'],
  ['9', 'exception'],
  ['10', 'exception'],
  ['80', 'out_for_delivery'],
  ['85', 'ready_for_pickup'],
]);

export const statusMap: CarrierStatusMap = {
  stage(code, wording) {
    if (code === '80' && wording === 'recogido en cliente') return 'accepted';
    return code ? stages.get(code) : undefined;
  },
  gaps: [{ code: '13', note: 'The partner arranged a later delivery round.' }],
};
