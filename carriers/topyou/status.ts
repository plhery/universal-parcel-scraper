import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);

/**
 * TopYou's scan status codes, as its tracker labels them. 15 also marks the
 * delivery carrier's scans up to the delivery, out for delivery included, so
 * it says no more than that the parcel moves.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['0', 'registered'], // 预上网: announced, not yet received.
  ['5', 'accepted'], // 头程入库: booked in at the first-mile warehouse.
  ['10', 'in_transit'], // 头程出库: out of the first-mile warehouse.
  ['13', 'in_transit'], // 转运: transferred.
  ['15', 'in_transit'], // 运输途中: in transit.
  ['20', 'in_transit'], // 到达目的国家: arrived in the destination country.
  ['25', 'customs'], // 清关: in customs clearance.
  ['30', 'delivered'], // 已签收: signed for.
  ['35', 'exception'], // 投递异常: a delivery problem.
  ['40', 'returned'], // 退件: returned.
]);
// Codes that settle a scan whatever its wording says.
const DECISIVE = new Set(['30', '40']);

/**
 * A scan's stage: its wording in TopYou's map, then a delivered or returned
 * code, then the shared wording rules, then its code.
 */
export function topyouStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = WORDINGS.stage(normalizeStatusWording(wording)) ?? (DECISIVE.has(code) ? CODES.get(code) : undefined);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  if (worded.source !== 'none') return worded;
  const coded = CODES.get(code);
  return coded ? { stage: coded, source: 'carrier_map' } : null;
}

export const statusMap: CarrierStatusMap = { stage: (code, wording) => topyouStage(code ?? '', wording)?.stage, gaps: [] };
