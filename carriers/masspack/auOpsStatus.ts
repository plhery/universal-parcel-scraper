import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** One status of the AU-OPS tracker: its English and Chinese wording, and its stage. */
export interface AuOpsStatus {
  readonly en: string;
  readonly zh: string;
  readonly stage?: Stage;
}

export type AuOpsLanguage = 'en' | 'zh';

/**
 * The standard nodes of an AU-OPS order's tracking rows (`opsTrackStatus.sts` in the tracker's
 * translations), by code. Codes are case-sensitive: `Deliveried`, `deliveried` and `delivery`
 * are three nodes. An order is booked and confirmed, collected into a warehouse, shipped by air,
 * sea or express, cleared, and handed to a delivery round. Export steps stay in transit once
 * cleared; a node that only marks the order as waiting for an update has no stage.
 */
const NODES: ReadonlyMap<string, AuOpsStatus> = new Map<string, AuOpsStatus>([
  ['deliveryGuide', { en: 'Order Submit', zh: '业务单提交', stage: 'registered' }],
  ['confirm', { en: 'Confirmed', zh: '订单确认', stage: 'registered' }],
  ['plConfirmed', { en: 'PL Confirmed', zh: '货量已确认', stage: 'registered' }],
  ['Booked', { en: 'Space Booked', zh: '已订舱', stage: 'registered' }],
  ['SoReleased', { en: 'So Released', zh: '已放舱', stage: 'registered' }],
  ['TruckArranged', { en: 'Truck Arranged', zh: '已派车/自托', stage: 'registered' }],
  ['docment', { en: 'Get Label', zh: '制单', stage: 'registered' }],
  ['emsPickup', { en: 'Pick up(Express)', zh: '取件/上网', stage: 'accepted' }],
  ['pickup', { en: 'Pre-carriage', zh: '已提货', stage: 'accepted' }],
  ['wmsIn', { en: 'Cargo In', zh: '已入仓/签入', stage: 'accepted' }],
  ['checkIn', { en: 'Check in', zh: '签入', stage: 'accepted' }],
  ['offShelf', { en: 'Off shelf', zh: '下架/拣货', stage: 'accepted' }],
  ['checkOut', { en: 'Check Out', zh: '签出', stage: 'in_transit' }],
  ['wmsOut', { en: 'Cargo Out', zh: '已出仓/签出', stage: 'in_transit' }],
  ['CustomArranged', { en: 'Doing Custom Declaration', zh: '已安排报关', stage: 'customs' }],
  ['customsInspectionExp', { en: 'Export Inspection', zh: '出口查验', stage: 'customs' }],
  ['CustomReleased', { en: 'Custom Released', zh: '报关已放行', stage: 'in_transit' }],
  ['CtnStuffed', { en: 'Ctns Stuffed', zh: '已装柜/提货', stage: 'in_transit' }],
  ['vgmSent', { en: 'VGM Sent', zh: 'VGM已提交', stage: 'in_transit' }],
  ['atd', { en: 'Departure Confirmed', zh: '已离港', stage: 'in_transit' }],
  ['arrivedPod', { en: 'Arrival Confirmed', zh: '已到港', stage: 'in_transit' }],
  ['ctnAvailable', { en: 'CTNR Available', zh: '货柜可提取', stage: 'in_transit' }],
  ['customClearArranged', { en: 'Customs Clearance Arranged', zh: '已安排清关', stage: 'customs' }],
  ['customsInspection', { en: 'Import Inspection', zh: '进口查验', stage: 'customs' }],
  ['customCleared', { en: 'Import Cleared', zh: '海关放行(进口)', stage: 'in_transit' }],
  ['customRls', { en: 'Release', zh: '放行', stage: 'in_transit' }],
  ['transferOut', { en: 'On-carriage', zh: '已转运(提柜/入仓)', stage: 'in_transit' }],
  ['ctnReturned', { en: 'Empty Ctnr Returned', zh: '已还柜', stage: 'in_transit' }],
  ['overseasWarehouseOut', { en: 'Overseas Warehouse Out', zh: '海外仓已出仓', stage: 'in_transit' }],
  ['deliveryAppointed', { en: 'Delivery Appointed', zh: '已预约派送', stage: 'in_transit' }],
  ['Delivering', { en: 'Delivering', zh: '派送中', stage: 'out_for_delivery' }],
  ['Deliveried', { en: 'Deliveried', zh: '已派送', stage: 'delivered' }],
  ['deliveried', { en: 'Deliveried', zh: '派送完成', stage: 'delivered' }],
  ['delivery', { en: 'Deliveried', zh: '派送完成', stage: 'delivered' }],
  ['podConfirm', { en: 'POD Uploaded', zh: 'POD上传', stage: 'delivered' }],
  ['problem', { en: 'Problem Shipment', zh: '问题件', stage: 'exception' }],
  ['Cancelled', { en: 'Cancel/Take Back', zh: '取消/退载', stage: 'exception' }],
  ['waiting', { en: 'To be updated', zh: '待更新' }],
]);

/**
 * The nodes that date an estimate rather than a step: the estimated departure, arrival, transfer
 * and delivery dates, and the departure booked. A row for one is planned, not a scan.
 */
const ESTIMATES: ReadonlyMap<string, AuOpsStatus> = new Map<string, AuOpsStatus>([
  ['bookingEtd', { en: 'Booking ETD', zh: '订舱ETD' }],
  ['etd', { en: 'ETD', zh: '预计离港日期' }],
  ['eta', { en: 'ETA', zh: '预计到港日期' }],
  ['transferDate', { en: 'Transfer Date(E)', zh: '预计转运日期' }],
  ['deliveryDate', { en: 'Delivery Date(E)', zh: '预计派送日期' }],
]);

/**
 * The order's state (`expressTracking.state`), the label the tracker shows beside the order: the
 * states of a courier's own feed, with a partial delivery added. `0` is also the state of a
 * number the service does not have.
 */
const STATES: ReadonlyMap<string, AuOpsStatus> = new Map<string, AuOpsStatus>([
  ['0', { en: 'On The Way', zh: '在途中', stage: 'in_transit' }],
  ['1', { en: 'Express taked', zh: '已收货', stage: 'accepted' }],
  ['2', { en: 'Difficult', zh: '疑难', stage: 'exception' }],
  ['3', { en: 'Deliveried', zh: '已送达', stage: 'delivered' }],
  ['4', { en: 'Back To Sign', zh: '退签', stage: 'returned' }],
  ['5', { en: 'Dispatching', zh: '派送中', stage: 'out_for_delivery' }],
  ['6', { en: 'Send Back', zh: '退回', stage: 'returned' }],
  ['7', { en: 'Transfer', zh: '转单', stage: 'in_transit' }],
  ['8', { en: 'Partly delivered', zh: '部分送达', stage: 'in_transit' }],
]);

/** A standard node of a tracking row, by its code. */
export function auOpsNode(code: string): AuOpsStatus | undefined {
  return NODES.get(code);
}

/** A node that dates an estimate, by its code. */
export function auOpsEstimate(code: string): AuOpsStatus | undefined {
  return ESTIMATES.get(code);
}

/** The order's state, by its code. */
export function auOpsState(code: string): AuOpsStatus | undefined {
  return STATES.get(code);
}

/** The map of every AU-OPS tenant: node and state codes do not overlap. */
export const auOpsStatusMap: CarrierStatusMap = {
  stage: (code) => (code ? (NODES.get(code) ?? STATES.get(code))?.stage : undefined),
  gaps: [{ code: 'waiting', note: 'The order waits for an update: the row moves nothing, and the stage before it stands.' }],
};
