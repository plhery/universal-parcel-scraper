/**
 * JD Logistics international operation codes (`operationCode`), as the
 * international feed sends them on each scan. Codes not listed here leave the
 * scan to the shared wording rules.
 */
import type { ClassifiedStatus } from '../../core/status/index.js';

const MOVING: ClassifiedStatus = { status: 'in_transit', stage: 'in_transit' };

const CODES = new Map<string, ClassifiedStatus>([
  ['COSH', { status: 'pending', stage: 'registered' }],
  ['CCL', { status: 'in_transit', stage: 'customs' }],
  // Clearance completed: the parcel moves on.
  ['CXCCRS', MOVING],
  ['DMSCR', MOVING],
  ['SCVS', MOVING],
  ['VUVU', MOVING],
  ['DMLMLS', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['DLV', { status: 'delivered', stage: 'delivered' }],
]);

/** The status and stage for one operation code, or undefined when unmapped. */
export function jdLogisticsStatus(code: string): ClassifiedStatus | undefined {
  return CODES.get(code);
}
