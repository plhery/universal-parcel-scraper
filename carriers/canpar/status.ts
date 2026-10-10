import type { ClassifiedStatus } from '../../core/status/index.js';

const codes: Record<string, ClassifiedStatus> = {
  DEL: { status: 'delivered', stage: 'delivered' },
  NSR: { status: 'delivered', stage: 'delivered' },
  WC: { status: 'out_for_delivery', stage: 'out_for_delivery' },
  DRP: { status: 'in_transit', stage: 'ready_for_pickup' },
  PIC: { status: 'in_transit', stage: 'accepted' },
  ARR: { status: 'in_transit', stage: 'in_transit' },
  DPT: { status: 'in_transit', stage: 'in_transit' },
  SRT: { status: 'in_transit', stage: 'in_transit' },
  COA: { status: 'in_transit', stage: 'in_transit' },
  // A handoff to a local partner, extra handling and weather delays keep the parcel moving.
  INO: { status: 'in_transit', stage: 'in_transit' },
  XC: { status: 'in_transit', stage: 'in_transit' },
  WXX: { status: 'in_transit', stage: 'in_transit' },
  MIS: { status: 'exception', stage: 'exception' },
  // Delayed at Facility (Retardé au centre de tri): seen after missed or failed
  // deliveries, then either a delivery later that day or no further scan.
  HLD: { status: 'exception', stage: 'exception' },
  NL: { status: 'exception', stage: 'failed_attempt' },
  NH: { status: 'exception', stage: 'failed_attempt' },
  RTN: { status: 'exception', stage: 'returned' },
};

export function canparStatus(code: string): ClassifiedStatus | undefined {
  return Object.hasOwn(codes, code) ? codes[code] : undefined;
}
