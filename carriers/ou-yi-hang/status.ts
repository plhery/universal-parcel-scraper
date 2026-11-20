import type { Stage } from '../../core/status/index.js';

export const shipmentStages: ReadonlyMap<string, Stage> = new Map([
  ['ND', 'in_transit'],
]);

export const movementStages: ReadonlyMap<string, Stage> = new Map([
  ['离开设施', 'in_transit'],
  ['抵达设施', 'in_transit'],
  ['已提取-留意签收', 'in_transit'],
  ['已装车-预计7/31交付', 'in_transit'],
  ['清关完成,待预约卸货位', 'in_transit'],
  ['到仓,待清关', 'customs'],
  ['航司拆板理货中', 'in_transit'],
  ['航班落地', 'in_transit'],
  ['航班起飞', 'in_transit'],
  ['出口报关放行,等待航班起飞', 'in_transit'],
  ['等待出口报关,预计7月27日航班', 'customs'],
  ['快件操作完成', 'in_transit'],
  ['快件到达作业中心', 'in_transit'],
  ['快件电子信息已经收到', 'registered'],
  ['发件人已创建标签，但是 UPS 尚未收到包裹。', 'registered'],
]);
