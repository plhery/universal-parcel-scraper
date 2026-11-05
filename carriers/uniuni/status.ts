import { languageStageStatus, wordingStage, type ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// The official client's milestone groups distinguish delivery, transfer and
// completed return. Failed attempts are observed individual scan states.
const STATES = new Map<number, ClassifiedStatus>([
  [190, { status: 'pending', stage: 'registered' }],
  [1870, { status: 'pending', stage: 'registered' }],
  ...[199, 1910, 4010, 195, 255, 218, 219, 200].map(code => [code, { status: 'in_transit', stage: 'in_transit' }] as [number, ClassifiedStatus]),
  [202, { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  [211, { status: 'exception', stage: 'failed_attempt' }],
  ...[203, 216, 228].map(code => [code, { status: 'delivered', stage: 'delivered' }] as [number, ClassifiedStatus]),
  ...[204, 217].map(code => [code, { status: 'in_transit', stage: 'in_transit' }] as [number, ClassifiedStatus]),
  ...[206, 207, 209, 215, 222, 229, 235].map(code => [code, { status: 'exception', stage: 'exception' }] as [number, ClassifiedStatus]),
  [230, { status: 'exception', stage: 'returned' }],
]);

export function uniuniStatus(code: number): ClassifiedStatus | undefined {
  return STATES.get(code);
}

/**
 * A cross-border shipper's notice that its data reached UniUni, which does not have the parcel yet: "on its
 * way to UniUni". UniUni's own scans never word it so, and its own "Order received" (190) is registered too.
 */
const SHIPPER_NOTICE = /^shipping information received\. your parcel is on its way to uniuni\b/i;

/**
 * A scan without UniUni's English summary is read by its own code, except 202:
 * cross-border shippers' scans carry it on every row until delivery, so there
 * only the wording tells a received label from a parcel out for delivery.
 */
export function uniuniPartnerStatus(code: number, text: string): ClassifiedStatus | undefined {
  if (code !== 202) return uniuniStatus(code);
  const stage = SHIPPER_NOTICE.test(text.trim()) ? 'registered' : wordingStage(text);
  return { status: languageStageStatus(stage), stage };
}

/** A Uni Store drop-off carries no status code, only this wording. */
export function uniuniDropOffStage(text: string): ClassifiedStatus | undefined {
  return /^Parcel dropped off at Uni Store\.?$/i.test(text) ? { status: 'in_transit', stage: 'accepted' } : undefined;
}

/**
 * What the map says about one scan: its state code, as the adapter reads it, and a Uni Store
 * drop-off, which has none, by its wording. 202 is left open: the stored row does not say whether
 * it is UniUni's own scan or a cross-border shipper's, except for the shipper's notice.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    if (code === null) return uniuniDropOffStage(wording)?.stage;
    if (code === '202') return SHIPPER_NOTICE.test(wording) ? 'registered' : undefined;
    return /^\d{1,9}$/.test(code) ? uniuniStatus(Number(code))?.stage : undefined;
  },
  gaps: [{
    code: '202',
    note: "Out for delivery in UniUni's own scans; a cross-border shipper's scans carry it on every row until delivery, and their wording decides. The stored row does not say whose it is, except the shipper's notice that its data reached UniUni.",
  }],
};
