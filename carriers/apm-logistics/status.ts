import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * APM Logistics' checkpoints and delivery status, by the wording its system gives them. The
 * tracker shows the handover to a partner, `PAKET DITERIMA VENDOR` or `FC`, as the parcel going
 * on to its destination city, and reads a delivery status of `TERKIRIM` or `DELIVERED` as
 * delivered.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['PAKET DITERIMA CABANG', 'accepted'],
  ['PAKET DITERIMA VENDOR', 'in_transit'],
  ['FC', 'in_transit'],
  ['TERKIRIM', 'delivered'],
  ['DELIVERED', 'delivered'],
]);

export function apmLogisticsStage(code: string | null): Stage | undefined {
  return code === null ? undefined : STAGES.get(code);
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => apmLogisticsStage(code),
  gaps: [],
};
