import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const IN_TRANSIT: ClassifiedStatus = { status: 'in_transit', stage: 'in_transit' };
const CUSTOMS: ClassifiedStatus = { status: 'in_transit', stage: 'customs' };
const OUT_FOR_DELIVERY: ClassifiedStatus = { status: 'out_for_delivery', stage: 'out_for_delivery' };
const DELIVERED: ClassifiedStatus = { status: 'delivered', stage: 'delivered' };
const RETURNED: ClassifiedStatus = { status: 'exception', stage: 'returned' };
const EXCEPTION: ClassifiedStatus = { status: 'exception', stage: 'exception' };

// Scan codes (`operationCode`) as the EMS app's trace service returns them for
// China Post international mail. statuses.json records the wording of each.
const CODES: Readonly<Record<string, ClassifiedStatus>> = {
  '713': IN_TRANSIT,
  '954': IN_TRANSIT,
  '989': IN_TRANSIT,
  '404': IN_TRANSIT,
  '500': IN_TRANSIT,
  '457': IN_TRANSIT,
  '505': IN_TRANSIT,
  // Closed into an export dispatch at an exchange office (已出口直封).
  '423': IN_TRANSIT,
  // Arrived at the destination's processing centre (到达寄达地处理中心).
  '459': IN_TRANSIT,
  '460': IN_TRANSIT,
  '461': IN_TRANSIT,
  '489': IN_TRANSIT,
  // Domestic flight legs: departed (已起飞) and landed (已落地).
  '911': IN_TRANSIT,
  '912': IN_TRANSIT,
  EXA: CUSTOMS,
  EXB: CUSTOMS,
  // Export customs released the item; like other carriers' releases, transit resumes.
  EXC: IN_TRANSIT,
  '462': OUT_FOR_DELIVERY,
  '702': OUT_FOR_DELIVERY,
  '463': DELIVERED,
  '542': { status: 'exception', stage: 'failed_attempt' },
  '711': RETURNED,
};

// Coarse state labels (`stateDesc`): the server's, and those the app's own
// state table prints. Only consulted for scan codes without a mapping above.
const STATES: Readonly<Record<string, ClassifiedStatus>> = {
  '已揽收': { status: 'in_transit', stage: 'accepted' },
  '已揽件': { status: 'in_transit', stage: 'accepted' },
  '运送中': IN_TRANSIT,
  '到达目的地': IN_TRANSIT,
  '到达境外目的地': IN_TRANSIT,
  '启运': IN_TRANSIT,
  '交运输商': IN_TRANSIT,
  '已起飞': IN_TRANSIT,
  '已落地': IN_TRANSIT,
  '清关中': CUSTOMS,
  '出口清关': CUSTOMS,
  '进口清关': CUSTOMS,
  '预报关中': CUSTOMS,
  '派送中': OUT_FOR_DELIVERY,
  '正在安排派送': OUT_FOR_DELIVERY,
  '等待客户网点取件': { status: 'in_transit', stage: 'ready_for_pickup' },
  '待取件': { status: 'in_transit', stage: 'ready_for_pickup' },
  '已签收': DELIVERED,
  '派件异常': EXCEPTION,
  '邮件异常': EXCEPTION,
  '退回寄件人': RETURNED,
  '待退回': RETURNED,
  '已退回': RETURNED,
};

export function chinaPostCodeStatus(code: string): ClassifiedStatus | undefined {
  return Object.hasOwn(CODES, code) ? CODES[code] : undefined;
}

export function chinaPostStateStatus(label: string): ClassifiedStatus | undefined {
  const key = label.trim();
  return Object.hasOwn(STATES, key) ? STATES[key] : undefined;
}

/** A scan's stage: its code first, then its coarse state label. */
export function chinaPostStatus(code: string, state: string): ClassifiedStatus | undefined {
  return chinaPostCodeStatus(code) ?? chinaPostStateStatus(state);
}

/**
 * What the map says about one scan by its code and wording. A mapped code
 * decides. Otherwise the scan was staged by its state label, which is its
 * wording only when the label replaced the text or dates the acceptance; other
 * wording leaves the stage to the rest of the reply.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => chinaPostCodeStatus(code ?? '')?.stage ?? chinaPostStateStatus(wording)?.stage,
  gaps: [],
};
