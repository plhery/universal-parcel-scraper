import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['delivered', 'delivered'], ['dispatched', 'out_for_delivery'], ['picked-up', 'in_transit'],
  ['returned to last mile hub', 'exception'], ['in return to last mile hub', 'exception'],
]);

export function fezDeliveryStage(code: string | null): Stage | undefined {
  return code ? STAGES.get(normalizeStatusWording(code)) : undefined;
}

export const statusMap: CarrierStatusMap = { stage: code => fezDeliveryStage(code), gaps: [] };
