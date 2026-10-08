import type { ClassifiedStatus } from '../../core/status/index.js';

const statuses: Record<string, ClassifiedStatus> = {
  DELIVERED: { status: 'delivered', stage: 'delivered' },
  'OUT FOR DELIVERY': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  'IN TRANSIT': { status: 'in_transit', stage: 'in_transit' },
  'IN TRANSIT FOR RETURN': { status: 'in_transit', stage: 'in_transit' },
  'ON THE WAY': { status: 'in_transit', stage: 'in_transit' },
  // The scan of the out-for-delivery milestone.
  DISPATCHED: { status: 'out_for_delivery', stage: 'out_for_delivery' },
  'PICKED UP': { status: 'in_transit', stage: 'accepted' },
  MANIFESTED: { status: 'pending', stage: 'registered' },
  'RTO DELIVERED': { status: 'exception', stage: 'returned' },
  DELIVERED_SELLER: { status: 'exception', stage: 'returned' },
  // Return to origin and a customer return, each scanned on delivery to the seller.
  RTO: { status: 'exception', stage: 'returned' },
  DTO: { status: 'exception', stage: 'returned' },
  LOST: { status: 'exception', stage: 'exception' },
  CANCELLED: { status: 'exception', stage: 'exception' },
  CANCELED: { status: 'exception', stage: 'exception' },
};

export function classifyDelhiveryStatus(value: string): ClassifiedStatus | undefined {
  return statuses[value.toUpperCase()];
}
