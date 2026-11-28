import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** The class Kalitta Air's tracker gives each status row, which the adapter keeps as its code. */
const stages = new Map<string, Stage>([
  ['manifested', 'in_transit'],
  ['arrived', 'in_transit'],
  ['consignmentcustoms', 'customs'],
  ['customs', 'customs'],
  ['cargocleared', 'in_transit'],
]);

/**
 * A row's stage by its class and wording. US Customs' own messages share the class `customs`: its
 * release reads like the tracker's "cleared by customs" row beside it. Documents delivered at the
 * waybill's destination leave the freight there for collection; at a transfer airport, as at
 * Anchorage before the flight on to New York, they do not.
 */
export function kalittaAirStage(code: string, wording: string, atDestination: boolean): Stage | undefined {
  if (code === 'awbdelivered') return atDestination ? 'ready_for_pickup' : 'in_transit';
  if (code === 'customs' && /^cleared\b/i.test(wording)) return 'in_transit';
  return stages.get(code);
}

export const statusMap: CarrierStatusMap = {
  stage(code, wording) {
    if (!code || code === 'awbdelivered') return undefined;
    return kalittaAirStage(code, wording, false);
  },
  gaps: [{
    code: 'awbdelivered',
    note: 'Documents delivered to the consignee or its agent leave the freight for collection only at the waybill\'s destination, which the row does not name.',
  }],
};
