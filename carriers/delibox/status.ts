import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const stages: ReadonlyMap<string, Stage> = new Map(([
  ['주문', 'registered'],
  ['집하', 'accepted'],
  ['HUB 입고', 'in_transit'],
  ['TC 입고', 'in_transit'],
  ['배송출발', 'out_for_delivery'],
  ['배송완료', 'delivered'],
] satisfies [string, Stage][]).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** Status mapping for scans read by this adapter. */
export const scanStatusMap: CarrierStatusMap = {
  stage: (code, wording) => code === null ? stages.get(normalizeStatusWording(wording)) : undefined,
  gaps: [],
};
