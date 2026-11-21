import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// Codes observed in the public Dutch tracking service, which shares the
// Canadian service's codes. Its short labels are often marketing phrases.
const STAGES: Readonly<Record<string, Stage>> = {
  '0': 'registered', '105': 'accepted', '106': 'in_transit', '300': 'out_for_delivery', '601': 'delivered', '860': 'exception',
  // A failed delivery, and the parcel brought back to the depot for another day.
  '590': 'failed_attempt', '610': 'failed_attempt',
};

/** The stage of a status code the tracking service is known to send. */
export function dragonflyNlCodeStage(code: string): Stage | undefined {
  return Object.hasOwn(STAGES, code) ? STAGES[code] : undefined;
}

/**
 * What the map says about one scan: its code. Another code is staged by the parcel's delivered
 * flag or the shared wording rules, and the stored scan does not keep the flag, so it stays open.
 */
export const statusMap: CarrierStatusMap = { stage: (code) => (code ? dragonflyNlCodeStage(code) : undefined), gaps: [] };
