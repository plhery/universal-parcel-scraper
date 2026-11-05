import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

// The origin milestone codes are documented by getCargoTrack. The web tracker
// adds the origin airport's receipt (AP), the flight and clearance milestones,
// JY for the hand-off to the destination carrier, and codes for that carrier's
// out-for-delivery (CB), delivery-point arrival (PB) and delivery (CC) scans.
// IA covers that carrier's other scans, and CA its depot scans: the map reads
// the wordings seen, the shared rules the rest.
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['IR', 'registered'], ['AF', 'accepted'], ['DF', 'in_transit'], ['GG', 'in_transit'], ['BG', 'in_transit'],
  ['AP', 'in_transit'], ['QF', 'in_transit'], ['QG', 'customs'], ['LD', 'in_transit'], ['YG', 'in_transit'], ['JY', 'in_transit'],
  ['CB', 'out_for_delivery'], ['PB', 'ready_for_pickup'], ['CC', 'delivered'],
]);
// Scans under IA, relayed without a code or under a tracking provider's own code: HuaHan's
// milestones in its English words, "Data processed" between departures from the origin
// facility, then the destination carrier's scans, after the hand-off, in its words.
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['shipment information received', 'registered'],
  ['arrived at origin facility', 'accepted'],
  ['departed from origin facility', 'in_transit'],
  ['transfer to origin airport', 'in_transit'],
  ['export customs clearance completed', 'in_transit'],
  ['departed from airport of origin', 'in_transit'],
  ['import customs clearance started', 'customs'],
  ['arrived at destination airport', 'in_transit'],
  ['import customs clearance completed', 'in_transit'],
  ['has been given to local carrier', 'in_transit'],
  ['data processed', 'in_transit'],
  ['we will pick up your parcel from the sender soon.', 'registered'],
  // CTT Express's notice of the parcel coming, relayed while HuaHan still has it in China.
  ['pendiente de recepción en ctt express', 'registered'],
  ['ready to ship, parcel received and processed', 'in_transit'],
  ['shipped', 'in_transit'],
  ['change of delivery address', 'in_transit'],
  ['the parcel is in the central warehouse waiting to be processed.', 'in_transit'],
  ['in transit, shipment arrived to sorting centre / shipment in the sorting centre', 'in_transit'],
  ['in transit', 'in_transit'],
  ['the parcel is on the way to the local warehouse.', 'in_transit'],
  ['in transit, shipment remained at sorting hub', 'in_transit'],
  ['in transit, arrived to hu hub', 'in_transit'],
  ['in transit, parcel has entered the linehaul network.', 'in_transit'],
  ['in transit, picked up | einrollung', 'in_transit'],
  ['in transit, scanned by dpd at parcel delivery centre.', 'in_transit'],
  ['in transit, at parcel delivery centre.', 'in_transit'],
  ['the courier will deliver the parcel soon. additional details are available in the sameday app, email or sms.', 'out_for_delivery'],
  ['delivery attempted', 'failed_attempt'],
  ['delivery attempted, unfortunately we have not been able to deliver your parcel. pickup parcelshop delivery after first delivery attempt.', 'failed_attempt'],
  ['awaiting pickup, parcel was deposited in pickup parcel station', 'ready_for_pickup'],
  // HuaHan's transfer warehouse in Chinese, and an American partner's scans it relays, written
  // ahead while the parcel is still in China: a hand-off to come, not the parcel's acceptance.
  ['货物离开操作中心', 'in_transit'],
  ['picked up by shipping partner', 'in_transit'],
  ['arrived shipping partner facility', 'in_transit'],
]);
// Milestones in Chinese with the English after them, and lines with a day, a flight, a time or a place.
const PATTERNS: ReadonlyArray<readonly [RegExp, Stage]> = [
  [/^快件从转运仓发出至机场，出口报关中/, 'customs'],
  [/^快件抵达机场，预计\d{1,2}号航班飞/, 'in_transit'],
  [/^航班延误，重新配载至\d{1,2}号航班飞/, 'in_transit'],
  [/^目的国清关完成/, 'in_transit'],
  [/^departed shipping partner facility\b/, 'in_transit'],
];

const GAPS = [{
  wording: 'the parcel was redirected. as soon as it is in the couriers possession, it will be processed as requested.',
  note: "The destination carrier's record of the recipient's redirection, written while the parcel was still in China: it moves nothing.",
}];
const GAP_WORDINGS = new Set(GAPS.map((gap) => gap.wording));

// HuaHan's own codes are two capitals; a provider relaying its scans puts its own code on them.
const OWN_CODE = /^[A-Z]{2}$/;
// HuaHan's codes for the destination carrier's scans that its words stage.
const CARRIER_SCAN_CODES = new Set(['IA', 'CA']);

function mappedStage(code: string, wording: string): Stage | undefined {
  return CODES.get(code) ?? (!OWN_CODE.test(code) || CARRIER_SCAN_CODES.has(code)
    ? WORDINGS.get(wording) ?? PATTERNS.find(([pattern]) => pattern.test(wording))?.[1] : undefined);
}

/** A scan's stage: its code or wording in the map, else the shared rules, else nothing. A recorded gap has none. */
export function huahanStage(code: string, wording: string): ClassifiedWording | null {
  const key = normalizeStatusWording(wording);
  if (!code && GAP_WORDINGS.has(key)) return null;
  const stage = mappedStage(code, key);
  if (stage) return { stage, source: 'carrier_map' };
  const classified = classifyWording(wording, 'pending');
  return classified.source === 'none' ? null : classified;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => mappedStage(code ?? '', wording),
  gaps: GAPS,
};
