import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { chinaPostDestinationStage, chinaPostRelayedStage } from '../china-post/status.js';

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
  ['the shipment is still in the process of arranging flights', 'in_transit'],
  ['export customs clearance completed', 'in_transit'],
  ['departed from airport of origin', 'in_transit'],
  ['import customs clearance started', 'customs'],
  ['arrived at destination airport', 'in_transit'],
  ['import customs clearance completed', 'in_transit'],
  ['has been given to local carrier', 'in_transit'],
  ['data processed', 'in_transit'],
  // The line to DHL, relayed under ND, and the hand-over to the service provider's warehouse (交仓), under IA.
  ['the shipment is in transit to dhl.', 'in_transit'],
  ['transferred to service provider(交仓）', 'in_transit'],
  ['we will pick up your parcel from the sender soon.', 'registered'],
  // CTT Express's notice of the parcel coming, relayed while HuaHan still has it in China.
  ['pendiente de recepción en ctt express', 'registered'],
  // DHL's record of the sender's data, relayed without a code before or after HuaHan's receipt in China, and the
  // order's electronic data in Chinese: records of data, not movements.
  ['the instruction data for this shipment have been provided by the sender to dhl electronically.', 'registered'],
  ['the instruction data for this shipment have been provided by the sender to dhl electronically', 'registered'],
  ['货物电子信息已经收到', 'registered'],
  // The same record in English, between the shipment's data and the origin facility's arrival.
  ['electronic item data received', 'registered'],
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
  // The same line's central and local warehouses, and a locker too busy to take the parcel, which goes to another
  // pickup point at the recipient's request before it arrives there: on the way, not an attempt.
  ['the parcel has arrived in the central warehouse. as soon as it is processed it will go to the local warehouse.', 'in_transit'],
  ['the parcel is in the local warehouse and is to be processed soon.', 'in_transit'],
  ['the parcel is in the local warehouse and will be processed shortly.', 'in_transit'],
  ['the delivery point is busy. we will try loading your parcel again later, and get back to you with news.', 'in_transit'],
  ['in transit, delivery address changed upon addressees request', 'in_transit'],
  ['we have redirected your parcel to the nearest available pickup point. we will let you know when you can collect it.', 'in_transit'],
  ['delivery attempted', 'failed_attempt'],
  ['delivery attempted, unfortunately we have not been able to deliver your parcel. pickup parcelshop delivery after first delivery attempt.', 'failed_attempt'],
  ['awaiting pickup, parcel was deposited in pickup parcel station', 'ready_for_pickup'],
  // Landmark Global's scans on the line to bpost: its record of the sender's data, then its
  // depot's scans after the hand-off. The outgoing scan, which HuaHan puts under CB, sends the
  // parcel on to the destination network days before a delivery round.
  ['shipment data uploaded', 'registered'],
  ['incoming scan at facility', 'in_transit'],
  ['outgoing scan at facility', 'in_transit'],
  ['out for delivery (on the way)', 'out_for_delivery'],
  ['delivery attempt (delivery not possible)', 'failed_attempt'],
  // The British line's partner before Royal Mail's own scans: its record of the data, then its depot
  // taking the parcel in, under IA, and its round, relayed without a code.
  ['shipment data processed', 'in_transit'],
  ['shipment received in depot', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  // HuaHan's transfer warehouse in Chinese, and an American partner's scans it relays, written
  // ahead while the parcel is still in China: a hand-off to come, not the parcel's acceptance.
  ['货物离开操作中心', 'in_transit'],
  ['picked up by shipping partner', 'in_transit'],
  ['arrived shipping partner facility', 'in_transit'],
  // China Post's receipt on the postal line, after HuaHan's own acceptance: the hand-over to the post.
  ['中国邮政已收取邮件', 'in_transit'],
  // HuaHan's transfer warehouse taking the parcel in after its departure from the origin facility,
  // and sending the shipments on before the export declaration; on another line, its collection
  // there and its shipping out a day or two later, before the departure to the next facility.
  ['shipment received', 'in_transit'],
  ['shipments were sent', 'in_transit'],
  ['parcel has been collected.', 'in_transit'],
  ['parcel has been shipped out of the warehouse.', 'in_transit'],
  // The same line's departure to the service provider, before the hand-over to the airline, and the
  // import clearance after the flight lands, relayed without a code.
  ['parcel departed from facility to service provider.', 'in_transit'],
  ['the goods are clearing customs', 'customs'],
  // A destination post's scans after the hand-off: its posting record of the parcel HuaHan gave it,
  // not the parcel's acceptance, its exchange office's departure and arrival, its transport, its
  // notice of the coming delivery, and two rounds that did not deliver, under FI.
  ['posting/collection', 'in_transit'],
  ['departure to country of destination', 'in_transit'],
  ['arrival from abroad', 'in_transit'],
  ['in transport', 'in_transit'],
  ['your shipment has arrived at the postal operator of the country of destination and will be delivered in the coming days.', 'in_transit'],
  ['unsuccessful (physical) delivery', 'failed_attempt'],
  ['not delivered - addressee not present- message left', 'failed_attempt'],
  // An American courier's scans after the hand-off at the destination: its departure from a facility, under IA, then
  // its local facility taking the parcel in and its round, relayed without a code.
  ['parcel departed from facility.', 'in_transit'],
  ['parcel received by local facility.', 'in_transit'],
  ['parcel is out for delivery.', 'out_for_delivery'],
]);
// Milestones in Chinese with the English after them, and lines with a day, a flight, a time or a place.
const PATTERNS: ReadonlyArray<readonly [RegExp, Stage]> = [
  // On the way to the airport with the export declaration under way, a routine step before the flight.
  [/^快件从转运仓发出至机场，出口报关中/, 'in_transit'],
  [/^快件抵达机场，预计\d{1,2}号航班飞/, 'in_transit'],
  [/^航班延误，重新配载至\d{1,2}号航班飞/, 'in_transit'],
  [/^目的国清关完成/, 'in_transit'],
  // The pallet broken down after the flight's arrival.
  [/^拆板中/, 'in_transit'],
  [/^departed shipping partner facility\b/, 'in_transit'],
  // USPS's facility scans, the facility after a comma: USPS takes the parcel over from HuaHan,
  // which accepted it in China, and moves it on. Its pre-advice comes while HuaHan still has it.
  [/^accepted at usps facility\b/, 'in_transit'],
  [/^arrived at usps facility\b/, 'in_transit'],
  [/^departed usps facility\b/, 'in_transit'],
  [/^pre-shipment info sent to usps\b/, 'registered'],
  // USPS's label for its leg, relayed without a code like its pre-advice: a record of data, not a movement.
  [/^shipping label created\b/, 'registered'],
  // USPS moving the parcel between its facilities, relayed with the facility after the comma left empty.
  [/^in transit to next facility\b/, 'in_transit'],
  // The American courier's facility taking the parcel in, named by its code.
  [/^parcel received by [a-z]{2,6}\d{1,3}\.?$/, 'in_transit'],
  [/^in transit, arriving on time\b/, 'in_transit'],
];

const GAPS = [{
  wording: 'the parcel was redirected. as soon as it is in the couriers possession, it will be processed as requested.',
  note: "The destination carrier's record of the recipient's redirection, written while the parcel was still in China: it moves nothing, so it keeps the stage of the scan before it.",
}, {
  wording: 'processed',
  note: "Landmark Global's processing of the sender's data at the minute of its upload, relayed without a code before HuaHan's receipt in China: it moves nothing, so it keeps the stage of the scan before it and names no place.",
}];
const GAP_WORDINGS = new Set(GAPS.map((gap) => gap.wording));
// The number the parcel was transferred under, given alone: it moves nothing.
const TRANSFER = /^转单[:：]/;
const TRANSFER_NOTE = 'The number the parcel was transferred under, given alone without a code: it moves nothing, so it keeps the stage of the scan before it.';

/** Whether a scan is a notice relayed without a code: it keeps the stage of the scan before it. */
export const huahanNotice = (code: string, wording: string): boolean => {
  const key = normalizeStatusWording(wording);
  return !code && (GAP_WORDINGS.has(key) || TRANSFER.test(key));
};

// HuaHan's own codes are two capitals; a provider relaying its scans puts its own code on them.
const OWN_CODE = /^[A-Z]{2}$/;
// HuaHan's codes for the destination carrier's scans that its words stage. On the postal line DR
// also carries the destination post's arrivals, ND USPS's facility scans and FI a post's rounds
// that did not deliver.
const CARRIER_SCAN_CODES = new Set(['IA', 'CA', 'DR', 'ND', 'FI']);
// HuaHan's codes for the destination carrier's last steps. It also puts CB on USPS's departure
// from a distribution centre, so the relayed words decide when they name a step, the code otherwise.
const LAST_STEP_CODES = new Set(['CB', 'PB', 'CC']);

// On the postal line HuaHan relays China Post's scans in China Post's Chinese, offices in 【】,
// and the destination post's as China Post copies them: China Post's vocabulary reads both.
function wordingStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording) ?? PATTERNS.find(([pattern]) => pattern.test(wording))?.[1]
    ?? chinaPostRelayedStage(wording) ?? chinaPostDestinationStage(wording);
}

function mappedStage(code: string, wording: string): Stage | undefined {
  if (LAST_STEP_CODES.has(code)) return wordingStage(wording) ?? CODES.get(code);
  return CODES.get(code) ?? (!OWN_CODE.test(code) || CARRIER_SCAN_CODES.has(code) ? wordingStage(wording) : undefined);
}

/** A scan's stage: its code or wording in the map, else the shared rules, else nothing. A recorded gap has none. */
export function huahanStage(code: string, wording: string): ClassifiedWording | null {
  const key = normalizeStatusWording(wording);
  if (huahanNotice(code, wording)) return null;
  const stage = mappedStage(code, key);
  if (stage) return { stage, source: 'carrier_map' };
  const classified = classifyWording(wording, 'pending');
  return classified.source === 'none' ? null : classified;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => mappedStage(code ?? '', wording),
  gaps: GAPS,
  gapNote: (code, wording) => (!code && TRANSFER.test(wording) ? TRANSFER_NOTE : undefined),
};
