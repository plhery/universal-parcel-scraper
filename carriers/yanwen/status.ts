import type { CarrierStatus } from '../../core/result/index.js';
import type { ClassifiedStatus, Stage } from '../../core/status/index.js';

const WORDING = new Map<string, ClassifiedStatus>([
  ['Delivered.', { status: 'delivered', stage: 'delivered' }],
  ['Shipment out for delivery.', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['<User not at home>', { status: 'exception', stage: 'failed_attempt' }],
  ['<wrong address>', { status: 'exception', stage: 'failed_attempt' }],
  ['Arrived.', { status: 'in_transit', stage: 'in_transit' }],
  ['Received.', { status: 'in_transit', stage: 'in_transit' }],
  ['Batch delivery to carrier', { status: 'in_transit', stage: 'in_transit' }],
  ['Pick up by local carrier at destination port', { status: 'in_transit', stage: 'in_transit' }],
  ['International shipment release - Import', { status: 'in_transit', stage: 'in_transit' }],
  ['International shipment release - Export', { status: 'in_transit', stage: 'in_transit' }],
  ['Port of destination - Arrival', { status: 'in_transit', stage: 'in_transit' }],
  ['Port of departure - Departure', { status: 'in_transit', stage: 'in_transit' }],
  ['Port of departure - Received by carrier', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at domestic terminal station', { status: 'in_transit', stage: 'in_transit' }],
  ['Yanwen facility - Outbound', { status: 'in_transit', stage: 'in_transit' }],
  ['Yanwen Pickup Scan', { status: 'in_transit', stage: 'accepted' }],
  ['Order processed by shipper', { status: 'pending', stage: 'registered' }],
  ['Order Submited.', { status: 'pending', stage: 'registered' }],
  ['Waybill Generated', { status: 'pending', stage: 'registered' }],
  ['Shipping Order Created.', { status: 'pending', stage: 'registered' }],
  // Last-mile wording relayed without codes. Pre-advice lines come before the
  // parcel leaves China; a partner's acceptance follows Yanwen's own pickup
  // scan, so it is a handover rather than the parcel's acceptance.
  ['Pre-Shipment, USPS Awaiting Item', { status: 'pending', stage: 'registered' }],
  ['Registered parcel data, parcel not dispatched yet', { status: 'pending', stage: 'registered' }],
  ['Shipping information received. Your parcel is on its way to UniUni for delivery to you', { status: 'pending', stage: 'registered' }],
  ['Accepted at USPS Origin Facility', { status: 'in_transit', stage: 'in_transit' }],
  ['Your shipment has been accepted by delivery carrier', { status: 'in_transit', stage: 'in_transit' }],
  ['Parcel dispatched to be delivered', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['UA.In the New Post Office', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
]);

// Yanwen files each parcel under a category its status filter names:
// 制单完成 Info_Received, 运输途中 In_Transportation, 正在派送 Out_For_Delivery,
// 到达待取 Available_For_Pick_Up, 投递成功 Delivered, 投递失败 Undelivered,
// 包裹异常 Exception and 包裹退回 Returned. In transit spans customs and the
// partners' legs, so the newest scan names that stage. 追踪结束 End_of_Tracking
// only says Yanwen stopped following the parcel, and 查询不到 Not_Found is absence.
const CATEGORY = new Map<string, { status: CarrierStatus; stage?: Stage }>([
  ['制单完成', { status: 'pending', stage: 'registered' }],
  ['运输途中', { status: 'in_transit' }],
  ['正在派送', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['到达待取', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  ['投递成功', { status: 'delivered', stage: 'delivered' }],
  ['投递失败', { status: 'exception', stage: 'failed_attempt' }],
  ['包裹异常', { status: 'exception', stage: 'exception' }],
  ['包裹退回', { status: 'exception', stage: 'returned' }],
]);

export function yanwenStatus(description: string, code?: string): ClassifiedStatus | undefined {
  // The timeline marks the delivery scan with its LM40 milestone icon, whatever
  // wording the last-mile carrier used for it.
  if (code === 'LM40') return { status: 'delivered', stage: 'delivered' };
  // Partner wording can prefix its facility in full-width brackets. Removing
  // that observed prefix makes the remaining exact wording reusable.
  return WORDING.get(description.replace(/^【[^】]*】\s*/, '').trim());
}

/** The parcel's status from the category on its identity field, for scans the map does not know. */
export function yanwenCategory(category: unknown): { status: CarrierStatus; stage?: Stage } | undefined {
  return typeof category === 'string' ? CATEGORY.get(category) : undefined;
}
