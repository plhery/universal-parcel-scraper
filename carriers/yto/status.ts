import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const STATUS = new Map<string, ClassifiedStatus>([
  ['123', { status: 'in_transit', stage: 'in_transit' }],
  ['756', { status: 'in_transit', stage: 'in_transit' }],
  ['310', { status: 'in_transit', stage: 'accepted' }],
  ['311', { status: 'in_transit', stage: 'accepted' }],
  ['111', { status: 'in_transit', stage: 'in_transit' }],
  ['131', { status: 'in_transit', stage: 'in_transit' }],
  ['171', { status: 'in_transit', stage: 'in_transit' }],
  ['136', { status: 'in_transit', stage: 'in_transit' }],
  ['176', { status: 'in_transit', stage: 'in_transit' }],
  ['710', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['741', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['746', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['745', { status: 'delivered', stage: 'delivered' }],
  ['835', { status: 'exception', stage: 'exception' }],
  // A security check in the network, seen for a winter sports event: the parcel moves on.
  ['996', { status: 'in_transit', stage: 'in_transit' }],
  // YTO's overseas centres, on a YTO Global waybill.
  ['PU_PICKUP_SUCCESS', { status: 'in_transit', stage: 'accepted' }],
  ['DEBUS', { status: 'in_transit', stage: 'in_transit' }],
  ['SENT_SCAN', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
]);

/**
 * The codes YTO's overseas centres scan under, such as its Sydney centre on a YTO Global waybill.
 * The feed gives their clocks no zone, and the centre is not in China.
 */
const OVERSEAS = new Set(['PU_PICKUP_SUCCESS', 'DEBUS', 'SENT_SCAN']);

export function isYtoOverseasCode(code: string): boolean {
  return OVERSEAS.has(code);
}

/** The locker or station code, read with its sign type. */
const STATION = '751';

/** Exact operation codes from the domestic website; unfamiliar codes stay unmapped. */
export function ytoStatus(code: string, signType?: unknown): ClassifiedStatus | undefined {
  if (code === STATION) return signType === '1'
    ? { status: 'in_transit', stage: 'in_transit' } : { status: 'in_transit', stage: 'ready_for_pickup' };
  return STATUS.get(code);
}

// The label of each operation code that has one, for a scan the feed sends with its code and
// description but no label: the website's scan labels, those its client maps a code to, and
// those a provider relays with the code.
const LABELS = new Map<string, string>([
  ['310', '揽收扫描'], ['131', '装件入车扫描'], ['171', '下车扫描'], ['710', '派件扫描'], ['745', 'PDA正常签收扫描'],
  ['311', '已取件'], ['111', '运输中'], ['136', '运输中'], ['176', '运输中'], ['741', '派件中'], ['746', '派件中'],
  ['123', '快件城市信息'], ['756', '小件员取出'], ['835', '退回件扫描'], ['996', '冬运会安检'],
  // An overseas centre's description, "<centre>,已揽收", ends with the label.
  ['PU_PICKUP_SUCCESS', '已揽收'], ['DEBUS', '已收入'], ['SENT_SCAN', '派送扫描'],
]);

/**
 * The label the website gives an operation code, where the code has one. The locker or station
 * code has two, told apart by its sign type as `ytoStatus` reads it: the courier taking the parcel
 * back out, or the parcel stored for collection ("您的快件已存放至【…驿站…】，请您及时取件").
 */
export function ytoCodeLabel(code: string, signType?: unknown): string | undefined {
  if (code === STATION) return signType === '1' ? '小件员取出' : '入柜|入库';
  return LABELS.get(code);
}

/** The wording of a signature on the way back: the sender took the parcel. */
export const YTO_RETURNED = 'Returned to the sender';

/**
 * What the map says about one scan by its operation code, where a signature
 * worded as the trip back is the return. Code 751 is read by a sign type the
 * code does not carry, so the code alone gives it no stage.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const stage = code && code !== STATION ? ytoStatus(code)?.stage : undefined;
    return stage === 'delivered' && wording === normalizeStatusWording(YTO_RETURNED) ? 'returned' : stage;
  },
  gaps: [],
};

export interface YtoScan {
  stage: Stage;
  wording: string;
  returnLeg?: true;
}

// English is ParcelsApp's translation of the label, where one was seen.
const SCANS: ReadonlyArray<readonly [chinese: string, english: string | null, stage: Stage, wording: string]> = [
  ['揽收扫描', 'Pickup scan', 'accepted', 'Picked up'],
  // The courier's own pickup, under the same code as the pickup scan.
  ['业务员收件', null, 'accepted', 'Picked up'],
  ['装件入车扫描', 'Load scan into vehicle', 'in_transit', 'Loaded for transport'],
  ['下车扫描', 'Get off scan', 'in_transit', 'Unloaded at a sorting centre'],
  ['快件城市信息', 'Package city information', 'in_transit', 'In transit'],
  ['退回件扫描', 'Return package scan', 'exception', 'Return to the sender started'],
  ['派件扫描', 'Delivery scan', 'out_for_delivery', 'Out for delivery'],
  ['入柜|入库', 'In cabinet | In storage', 'ready_for_pickup', 'In a parcel locker or pickup station'],
  // The courier took the parcel back out of the locker or station.
  ['小件员取出', 'Small item handler takes out.', 'in_transit', 'Taken out of the locker by the courier'],
  ['PDA正常签收扫描', 'PDA normal delivery scan', 'delivered', 'Delivered'],
  // A security check in the network for a winter sports event: the parcel moves on.
  ['冬运会安检', null, 'in_transit', 'Security check'],
  // An overseas centre takes the parcel into YTO's network, receives it, then sends it out for delivery.
  ['已揽收', null, 'accepted', 'Picked up'],
  ['已收入', null, 'in_transit', 'Received at a sorting centre'],
  ['派送扫描', null, 'out_for_delivery', 'Out for delivery'],
];

function key(label: string): string {
  return label.trim().replace(/\s*\|\s*/g, '|').replace(/[.。]+$/, '').toLowerCase();
}

const BY_LABEL = new Map(SCANS.flatMap(([chinese, english, stage, wording]) => {
  const entry: YtoScan = { stage, wording, ...(chinese === '退回件扫描' ? { returnLeg: true } : {}) };
  return [chinese, english].filter((label) => label !== null).map((label) => [key(label), entry] as const);
}));

/** The stage and stored wording of one YTO scan label, Chinese or translated. */
export function ytoScan(label: string): YtoScan | undefined {
  return BY_LABEL.get(key(label));
}
