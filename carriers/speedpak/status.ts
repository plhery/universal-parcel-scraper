import type { ClassifiedStatus } from '../../core/status/index.js';

const MAP: Readonly<Record<string, ClassifiedStatus>> = {
  'Shipment Data Received': { status: 'pending', stage: 'registered' },
  'Package Received': { status: 'in_transit', stage: 'accepted' },
  'Arrived at Regional Distribution Center': { status: 'in_transit', stage: 'in_transit' },
  'Departed from Regional Distribution Center': { status: 'in_transit', stage: 'in_transit' },
  'Export Customs Declaration Completed': { status: 'in_transit', stage: 'in_transit' },
  'Departed from Origin Country': { status: 'in_transit', stage: 'in_transit' },
  'Arrived at Destination Hub': { status: 'in_transit', stage: 'in_transit' },
  'Import Customs Clearance Completed': { status: 'in_transit', stage: 'in_transit' },
  '货物运输中': { status: 'in_transit', stage: 'in_transit' },
  'Arrival scan': { status: 'in_transit', stage: 'in_transit' },
  'Out for delivery': { status: 'out_for_delivery', stage: 'out_for_delivery' },
};

export function speedpakStatus(wording: string): ClassifiedStatus | null {
  if (wording === 'Delivered' || /^Delivered\. \(/.test(wording)) return { status: 'delivered', stage: 'delivered' };
  return Object.hasOwn(MAP, wording) ? MAP[wording]! : null;
}
