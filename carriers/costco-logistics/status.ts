import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['Order Placed', 'registered'], ['Processing Order', 'registered'],
  ['Departed from Costco Distribution Center', 'in_transit'],
  ['Arrived at Costco Delivery Center', 'in_transit'],
  ['Out for Delivery', 'out_for_delivery'], ['Delivery Completed', 'delivered'],
].map(([wording, stage]) => [normalizeStatusWording(wording!), stage as Stage]));

export const costcoLogisticsStage = (wording: string): Stage | undefined => STAGES.get(normalizeStatusWording(wording));
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => costcoLogisticsStage(wording), gaps: [] };
