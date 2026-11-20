import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const STAGES = new Map(statuses.entries.map(entry => [entry.code, entry.stage as Stage]));

/** A scan code's stage. Out for delivery reads as ready for pickup when the waybill is for store collection. */
export function gollogStage(code: string, homeDelivery: unknown): Stage | undefined {
  return code === 'OND' && homeDelivery === false ? 'ready_for_pickup' : STAGES.get(code);
}

/** The map reads a scan's code. OND depends on the waybill's delivery type, which a scan does not keep. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code && code !== 'OND' ? STAGES.get(code) : undefined),
  gaps: [],
};
