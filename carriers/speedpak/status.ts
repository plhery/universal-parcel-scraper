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

const MOVING: ClassifiedStatus = { status: 'in_transit', stage: 'in_transit' };

/**
 * SpeedPAK's own Chinese label for each scan (`eventDescCn`). It stays in
 * SpeedPAK's vocabulary when the English text is a last-mile carrier's
 * wording, so it classifies the scans the English map does not know.
 */
const LABELS: Readonly<Record<string, ClassifiedStatus>> = {
  订单接受: { status: 'pending', stage: 'registered' },
  订单已创建: { status: 'pending', stage: 'registered' },
  包裹已揽收: { status: 'in_transit', stage: 'accepted' },
  '大包收货确认(A-SCAN)': { status: 'in_transit', stage: 'accepted' },
  进入集货中心: MOVING,
  离开集货中心: MOVING,
  进入分拣中心: MOVING,
  到达分拣中心: MOVING,
  离开分拣中心: MOVING,
  出口国报关完成: MOVING,
  始发地出发: MOVING,
  航班起飞: MOVING,
  航班到达: MOVING,
  目的地到港: MOVING,
  干线运输到达: MOVING,
  进口国清关完成: MOVING,
  进口清关完成: MOVING,
  货物运输中: MOVING,
  到达站点: MOVING,
  离开站点: MOVING,
  站点扫描: MOVING,
  同步尾程供应商: MOVING,
  尾程转运中: MOVING,
  开始派送: { status: 'out_for_delivery', stage: 'out_for_delivery' },
  派送完成: { status: 'delivered', stage: 'delivered' },
};

export function speedpakStatus(wording: string): ClassifiedStatus | null {
  if (wording === 'Delivered' || /^Delivered\. \(/.test(wording)) return { status: 'delivered', stage: 'delivered' };
  return Object.hasOwn(MAP, wording) ? MAP[wording]! : null;
}

/** The English wording's status, else the Chinese label's. */
export function speedpakScanStatus(wording: string, label: string): ClassifiedStatus | null {
  return speedpakStatus(wording) ?? (Object.hasOwn(LABELS, label) ? LABELS[label]! : null);
}
