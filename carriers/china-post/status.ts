import type { ClassifiedStatus } from '../../core/status/index.js';
import { statusWordings, type WordedStatus } from '../../core/status/english.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

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

// China Post words its scans in Chinese only. A state label's English is its
// entry's in statuses.json. A scan text's places, in 【】, are left out of its
// key (`chinaPostLabel`): the scan keeps its place as its location. The English
// is China Post's own where its relayed feed gave one (17TRACK passes it on
// where the place belongs, "Arrival at Processing Center【…】"), else
// ParcelsApp's translation of the label, else a plain rendering.
const WORDINGS = statusWordings(statuses.entries.filter((entry): entry is typeof entry & WordedStatus => 'wording' in entry));
const LABELS: ReadonlyArray<readonly [label: string, english: string]> = [
  // China Post's own English.
  ['邮件到达处理中心…', 'Arrival at processing center'],
  ['邮件离开处理中心…', 'Departure from processing center'],
  // The same for an express item (快件), as a forwarder's feed relays them.
  ['快件到达处理中心…', 'Arrival at processing center'],
  ['快件离开处理中心…', 'Departure from processing center'],
  ['出口清关完成…', 'Export customs clearance completed'],
  ['目的国清关完成…', 'Import customs clearance completed'],
  ['出门投递…', 'Out for delivery'],
  ['承运商接收', 'Received by carrier'],
  ['抵达', 'Arrival'],
  ['干线中转', 'In transit'],
  ['邮件在该国内转运中', 'In transit'],
  ['目的地转运…', 'In transit'],
  // ParcelsApp's translations.
  ['中国邮政已收取邮件', 'China Post has received the mail'],
  ['飞机进港', 'Plane has landed'],
  ['航空公司接收', 'Received by airline'],
  ['航空公司启运', 'Airline departure'],
  ['出口海关/放行', 'Export customs release'],
  ['到达寄达地', 'Arrive at the place of destination'],
  // ParcelsApp keeps 收寄点 (the office of posting) in Chinese: "Departed from 收寄点【…】".
  ['离开收寄点…', 'Departed from the office of posting'],
  // Plain renderings of the scan texts.
  ['邮件到达…', 'Arrival'],
  ['邮件离开…', 'Departure'],
  ['邮件离开…，正在发往下一站', 'Departed for the next stop'],
  ['邮件离开…，正在发往…', 'Departed for the next office'],
  ['邮件离开…，正在发往航站准备安检', "Departed for the airport's security check"],
  ['邮件已在…完成分拣，准备发出', 'Sorted and ready to leave'],
  ['邮件已完成分拣，准备发出', 'Sorted and ready to leave'],
  ['邮件到达…，准备发往…', 'Arrived, to leave for the next office'],
  ['邮件已乘机由…飞往…', 'Left on a flight'],
  ['您的邮件正途经…', 'Passing through'],
  ['…已出口直封', 'Closed into an export dispatch'],
  ['已交承运商运输', 'Handed to the carrier for transport'],
  ['送交出口海关', 'Presented to export customs'],
  ['出口海关/留存待验', 'Held by export customs for inspection'],
  ['送交境外进口海关', 'Presented to import customs abroad'],
  ['境外进口海关留存待验', 'Held by import customs abroad for inspection'],
  ['寄达地海关允许进口', 'Import allowed by destination customs'],
  ['到达寄达地处理中心', 'Arrival at processing center in the destination country'],
  ['离开…处理中心', 'Departure from processing center'],
  ['离开境外经转局', 'Departed from a transit office abroad'],
  // The origin post's own exchange scans, which China Post mirrors on an item from abroad.
  ['到达境外出口互换局', "Arrival at the origin post's office of exchange"],
  ['离开境外出口互换局', "Departure from the origin post's office of exchange"],
  ['已到达…投递局', 'Arrived at the delivery office'],
  ['…安排投递', 'Out for delivery'],
  ['邮件正在派送中', 'Out for delivery'],
  ['…已妥投', 'Delivered'],
  ['…已收寄', 'Accepted'],
  // An attempt, with what was done after it in brackets: "已试投/投递失败（/已通知客户）".
  ['已试投/投递失败', 'Delivery attempted, not delivered'],
];

/**
 * A label without its places: each 【…】 it holds, nested or cut off by the
 * feed, becomes "…", and a note in brackets after it goes. A place after the
 * label is optional, so a label that ends with one is also kept without it.
 */
export function chinaPostLabel(wording: string): string {
  let label = wording.replace(/\s+/g, ' ').trim();
  for (let previous = ''; previous !== label;) {
    previous = label;
    label = label.replace(/【[^【】]*】/g, '…');
  }
  return label.replace(/【[^【】]*$/, '…').replace(/(?:（[^（）]*）|\([^()]*\))$/, '').trim();
}

const ENGLISH: ReadonlyMap<string, string> = new Map(LABELS);
// The acceptance a forwarder's feed relays with the office out of its 【】: "示例处理中心已收寄".
const OFFICE_ACCEPTED = /^\p{Script=Han}{2,30}(?:中心|局|部|站|所|厅)已收寄$/u;
// The estimate of the next arrival, "预计【10月16日】到达【…】，两地距离…km，将在【…】更新邮件状态，请您放心。".
const ESTIMATE = /^预计【(\d{1,2})月(\d{1,2})日】到达/u;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The estimate's English, with its date and without its places and note. */
function estimate(wording: string): string | undefined {
  const match = ESTIMATE.exec(wording.replace(/\s+/g, ''));
  const month = match ? MONTHS[Number(match[1]) - 1] : undefined;
  const day = Number(match?.[2]);
  return month && day >= 1 && day <= 31 ? `Expected to arrive at the next stop on ${month} ${day}` : undefined;
}

/** The English shown for one China Post label, its places aside, or undefined when none is known. */
export function chinaPostEnglish(wording: string): string | undefined {
  const label = chinaPostLabel(wording);
  const bare = label.replace(/…$/, '');
  return estimate(wording) ?? ENGLISH.get(label) ?? ENGLISH.get(bare) ?? ENGLISH.get(`${label}…`)
    ?? WORDINGS.english(normalizeStatusWording(label)) ?? WORDINGS.english(normalizeStatusWording(bare))
    ?? (OFFICE_ACCEPTED.test(bare) ? 'Accepted' : undefined);
}

/**
 * The name a label gives in its only 【】, "启运【香港】", which its English
 * leaves out; undefined when it brackets anything but a name.
 */
export function chinaPostLabelPlace(wording: string): string | undefined {
  const named = /^[^【】]*【([^【】]+)】[^【】]*$/u.exec(wording.trim())?.[1]?.trim();
  return named && /^\p{L}[\p{L}\p{M} .'·-]{0,39}$/u.test(named) ? named : undefined;
}

/**
 * What the map says about one scan by its code and wording. A mapped code
 * decides. Otherwise the scan was staged by its state label, which is its
 * wording, in Chinese or in the English the adapter shows, only when the label
 * replaced the text or dates the acceptance; other wording leaves the stage to
 * the rest of the reply.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => chinaPostCodeStatus(code ?? '')?.stage ?? WORDINGS.stage(wording),
  gaps: [],
};
