import type { ClassifiedStatus } from '../../core/status/index.js';

const vocabulary: Record<string, ClassifiedStatus> = {
  // A pickup run to the shipper: the parcel is not with Blue Dart yet.
  'pickup employee is out to p/u shipment': { status: 'pending', stage: 'registered' },
  'shipment picked up': { status: 'in_transit', stage: 'accepted' },
  'shipment delivered': { status: 'delivered', stage: 'delivered' },
  'shipment out for delivery': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  'shipment arrived': { status: 'in_transit', stage: 'in_transit' },
  'shipment arrived at hub': { status: 'in_transit', stage: 'in_transit' },
  'shipment further connected': { status: 'in_transit', stage: 'in_transit' },
  'clubbed canvas bag scan': { status: 'in_transit', stage: 'in_transit' },
  'delivery delayed': { status: 'exception', stage: 'exception' },
  'delay caused beyond control': { status: 'exception', stage: 'exception' },
  'cnee refused id/otp not shared-incorrect': { status: 'exception', stage: 'failed_attempt' },
  'shipment returned back to shipper': { status: 'exception', stage: 'returned' },
};

export function classifyBlueDartStatus(wording: string): ClassifiedStatus | undefined {
  return vocabulary[wording.toLowerCase()];
}
