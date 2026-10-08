import type { ClassifiedStatus } from '../../core/status/index.js';

const labels: Record<string, ClassifiedStatus> = {
  'SHIPPING INFO SENT TO BRT': { status: 'pending', stage: 'registered' },
  COLLECTED: { status: 'in_transit', stage: 'accepted' },
  DEPARTED: { status: 'in_transit', stage: 'in_transit' },
  'ARRIVED AT DEPOT': { status: 'in_transit', stage: 'in_transit' },
  'FOR DELIVERY': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  'ARRIVED AT BRT LOCKER': { status: 'in_transit', stage: 'ready_for_pickup' },
  'COLLECTED AT BRT LOCKER': { status: 'delivered', stage: 'delivered' },
  'ARRIVED AT BRT-FERMOPOINT': { status: 'in_transit', stage: 'ready_for_pickup' },
  'COLLECTED AT BRT-FERMOPOINT': { status: 'delivered', stage: 'delivered' },
  'UNKNOWN/INCOMPLETE CONSIGNEE': { status: 'exception', stage: 'failed_attempt' },
  'RETURNED TO SENDER': { status: 'exception', stage: 'returned' },
  DELIVERED: { status: 'delivered', stage: 'delivered' },
};

export function classifyBrtStatus(label: string): ClassifiedStatus | undefined {
  const key = label.toUpperCase().trim();
  return Object.hasOwn(labels, key) ? labels[key] : undefined;
}
