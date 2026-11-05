import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['Подготавливается к отправке в службу доставки', 'registered'], ['Получен в службе доставки', 'accepted'],
  ['Отправлен в город назначения', 'in_transit'], ['Прибыл в город назначения', 'in_transit'], ['Заказ доставлен', 'delivered'],
].map(([wording, stage]) => [normalizeStatusWording(wording!), stage as Stage]));

export const topdeliveryStage = (wording: string): Stage | undefined => STAGES.get(normalizeStatusWording(wording));
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => topdeliveryStage(wording), gaps: [] };
