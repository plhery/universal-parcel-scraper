import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

interface State { description: string; stage: Stage; type: 'line_haul' | 'last_mile' }
const STATES: Readonly<Record<string, State>> = {
  '101': { description: 'Shipment registered', stage: 'registered', type: 'line_haul' },
  '199': { description: 'Shipment accepted', stage: 'in_transit', type: 'line_haul' },
  '130': { description: 'Container closed', stage: 'in_transit', type: 'line_haul' },
  '131': { description: 'Container opened', stage: 'in_transit', type: 'line_haul' },
  '200': { description: 'Received at station', stage: 'in_transit', type: 'line_haul' },
  '201': { description: 'At station', stage: 'in_transit', type: 'line_haul' },
  '210': { description: 'At last-mile station', stage: 'in_transit', type: 'last_mile' },
  '301': { description: 'Assigned to delivery route', stage: 'in_transit', type: 'last_mile' },
  '303': { description: 'Out for delivery', stage: 'out_for_delivery', type: 'last_mile' },
  '310': { description: 'Delivery attempted', stage: 'failed_attempt', type: 'last_mile' },
  '311': { description: 'Recipient unavailable', stage: 'failed_attempt', type: 'last_mile' },
  '206': { description: 'Returned to delivery station', stage: 'in_transit', type: 'last_mile' },
  '207': { description: 'Awaiting another delivery route', stage: 'in_transit', type: 'last_mile' },
  '360': { description: 'Delivered', stage: 'delivered', type: 'last_mile' },
};

export function xcargoState(code: string): State | undefined { return STATES[code]; }
export const statusMap: CarrierStatusMap = {
  stage: code => code ? xcargoState(code)?.stage : undefined,
  gaps: [],
};
