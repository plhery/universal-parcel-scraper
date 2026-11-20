import type { Stage } from '../../core/status/index.js';

export const stages: ReadonlyMap<string, Stage> = new Map([
  ['출발지 접수완료', 'accepted'],
  ['출발지 부분입고', 'accepted'],
  ['출발지 입고완료', 'accepted'],
  ['출발지 출고대기', 'in_transit'],
  ['출발지 이고대기', 'in_transit'],
  ['출발지 출항대기', 'in_transit'],
  ['항공운송중', 'in_transit'],
]);
