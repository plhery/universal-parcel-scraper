import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** The order's status as the tracker's page shows it: its label and its stage. */
export interface DaraiiStatus {
  readonly wording: string;
  readonly stage: Stage;
}

const DELIVERED: DaraiiStatus = { wording: 'Delivered', stage: 'delivered' };
const IN_TRANSIT: DaraiiStatus = { wording: 'In Transit', stage: 'in_transit' };

// The page's script names one status: 2 is delivered, and it labels every other one in transit.
const CODE = /^\d{1,3}$/;

/** The status of an order by the code of its newest scan, as the page reads it; undefined for no code. */
export function daraiiStatus(code: string | null): DaraiiStatus | undefined {
  if (code === null || !CODE.test(code)) return undefined;
  return code === '2' ? DELIVERED : IN_TRANSIT;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => daraiiStatus(code)?.stage,
  gaps: [],
};
