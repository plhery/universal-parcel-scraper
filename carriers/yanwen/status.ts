import type { CarrierStatus } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { chinaPostRelayedStage } from '../china-post/status.js';
import { withoutCourtesy } from '../j-and-t-au/identity.js';
import { J_AND_T_AU_HOTLINE, jAndTAuRelayedStage } from '../j-and-t-au/status.js';
import { yweMappedStage } from '../ywe/status.js';

const WORDING = new Map<string, ClassifiedStatus>([
  ['Delivered.', { status: 'delivered', stage: 'delivered' }],
  ['Shipment out for delivery.', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['<User not at home>', { status: 'exception', stage: 'failed_attempt' }],
  ['<wrong address>', { status: 'exception', stage: 'failed_attempt' }],
  ['Arrived.', { status: 'in_transit', stage: 'in_transit' }],
  ['Received.', { status: 'in_transit', stage: 'in_transit' }],
  ['Batch delivery to carrier', { status: 'in_transit', stage: 'in_transit' }],
  ['Pick up by local carrier at destination port', { status: 'in_transit', stage: 'in_transit' }],
  ['Custom Clearance in process - Import', { status: 'in_transit', stage: 'customs' }],
  ['International shipment release - Import', { status: 'in_transit', stage: 'in_transit' }],
  ['International shipment release - Export', { status: 'in_transit', stage: 'in_transit' }],
  ['Port of destination - Arrival', { status: 'in_transit', stage: 'in_transit' }],
  ['Port of departure - Departure', { status: 'in_transit', stage: 'in_transit' }],
  ['Port of departure - Received by carrier', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at domestic terminal station', { status: 'in_transit', stage: 'in_transit' }],
  ['Yanwen facility - Outbound', { status: 'in_transit', stage: 'in_transit' }],
  // China Post's receipt after Yanwen's outbound scan: Yanwen's hand-over to the post, not the parcel's acceptance.
  ['中国邮政已收取邮件', { status: 'in_transit', stage: 'in_transit' }],
  ['Yanwen Pickup Scan', { status: 'in_transit', stage: 'accepted' }],
  // Intake lines written in the seconds after the pickup scan, the partner's label
  // among them: the parcel is in Yanwen's hands and has not moved yet.
  ['Processing information input', { status: 'in_transit', stage: 'accepted' }],
  ['Shipment data received', { status: 'in_transit', stage: 'accepted' }],
  ['shipping label created', { status: 'in_transit', stage: 'accepted' }],
  ['Shipment order created', { status: 'in_transit', stage: 'accepted' }],
  ['Order processed by shipper', { status: 'pending', stage: 'registered' }],
  ['Order Submited.', { status: 'pending', stage: 'registered' }],
  ['Waybill Generated', { status: 'pending', stage: 'registered' }],
  ['Shipping Order Created.', { status: 'pending', stage: 'registered' }],
  // Last-mile wording relayed without codes. Pre-advice lines come before the
  // parcel leaves China; a partner's acceptance follows Yanwen's own pickup
  // scan, so it is a handover rather than the parcel's acceptance.
  ['Pre-Shipment, USPS Awaiting Item', { status: 'pending', stage: 'registered' }],
  ['Shipment information received', { status: 'pending', stage: 'registered' }],
  ['Registered parcel data, parcel not dispatched yet', { status: 'pending', stage: 'registered' }],
  ['Shipping information received. Your parcel is on its way to UniUni for delivery to you', { status: 'pending', stage: 'registered' }],
  ['Votre Colissimo va bientôt nous être confié ! Il est en cours de préparation chez votre expéditeur.', { status: 'pending', stage: 'registered' }],
  ['Accepted at USPS Origin Facility', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at USPS Regional Origin Facility', { status: 'in_transit', stage: 'in_transit' }],
  ['In Transit to Next Facility, Arriving On Time', { status: 'in_transit', stage: 'in_transit' }],
  ['Your shipment has been accepted by delivery carrier', { status: 'in_transit', stage: 'in_transit' }],
  ['Parcel Picked Up', { status: 'in_transit', stage: 'in_transit' }],
  // Yanwen sending the parcel on to InPost after its outbound scan.
  ['Despatched and en route to Inpost', { status: 'in_transit', stage: 'in_transit' }],
  ['Your shipment has arrived at sorting center', { status: 'in_transit', stage: 'in_transit' }],
  // A partner's manifest as the parcel leaves Yanwen's facility, then the destination leg's
  // release from customs, intake and arrival at the delivery office.
  ['Manifest created', { status: 'in_transit', stage: 'in_transit' }],
  // DHL's own line once Yanwen's facility has sent the parcel on to it.
  ['The shipment is in transit to DHL', { status: 'in_transit', stage: 'in_transit' }],
  // A destination partner's own record: its order before the parcel leaves China, then
  // its intake and transfer scans after Yanwen's batch handover at the destination port.
  ['Shipment created', { status: 'pending', stage: 'registered' }],
  ['Shipment under processing at origin hub', { status: 'in_transit', stage: 'in_transit' }],
  ['Shipment received', { status: 'in_transit', stage: 'in_transit' }],
  ['Shipment despatched to transshipment hub', { status: 'in_transit', stage: 'in_transit' }],
  ['Out customs authorities', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at destination', { status: 'in_transit', stage: 'in_transit' }],
  ['Handled by local carrier', { status: 'in_transit', stage: 'in_transit' }],
  // The destination partner's departure from its hub after the batch handover and its arrival at the
  // next depot, as DPD Romania words them.
  ['Departure Scan', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrival Scan', { status: 'in_transit', stage: 'in_transit' }],
  // A Belgian partner's hub taking the batch in and sending it on, minutes after the handover.
  ['Incoming scan at facility', { status: 'in_transit', stage: 'in_transit' }],
  ['Outgoing scan at facility', { status: 'in_transit', stage: 'in_transit' }],
  // The destination partner's post office holding the parcel for the recipient to collect.
  ['Prepared for Self-collecting by Consignee', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  ['Transport to delivery centre', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at delivery centre', { status: 'in_transit', stage: 'in_transit' }],
  ['Your shipment has been processed at sorting center and ready for shipping', { status: 'in_transit', stage: 'in_transit' }],
  ['Your shipment has departed from the transit origin', { status: 'in_transit', stage: 'in_transit' }],
  ['Your shipment has arrived at the transit destination', { status: 'in_transit', stage: 'in_transit' }],
  ['Parcel dispatched to be delivered', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['Your shipment is out for delivery', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  // Nova Poshta's leg in Ukraine, from the flight out of Hong Kong through customs at the border
  // to its branch, relayed in Yanwen's English. Customs holds the parcel at its terminal until the
  // clearance.
  ['He left the airport', { status: 'in_transit', stage: 'in_transit' }],
  ['An order for delivery to the destination country has been issued', { status: 'in_transit', stage: 'in_transit' }],
  ['The consignment arrived in the destination country', { status: 'in_transit', stage: 'in_transit' }],
  ['Shipment is in transit', { status: 'in_transit', stage: 'in_transit' }],
  ['Delivered to customs terminal', { status: 'in_transit', stage: 'customs' }],
  ['Customs clearance is complete', { status: 'in_transit', stage: 'in_transit' }],
  ['Left the customs terminal', { status: 'in_transit', stage: 'in_transit' }],
  ['The shipment goes to the recipient', { status: 'in_transit', stage: 'in_transit' }],
  ['At the terminal of the destination city', { status: 'in_transit', stage: 'in_transit' }],
  ['In the New Post Office', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  // The branch's hold ending uncollected: the parcel goes to storage, unclaimed, then to the
  // unclaimed cargo area. Its "Delivery is not possible" is the attempt Yanwen's Undelivered
  // category names.
  ['Sent to storage', { status: 'exception', stage: 'exception' }],
  ['Unsolicited shipment', { status: 'exception', stage: 'exception' }],
  ['Delivery is not possible', { status: 'exception', stage: 'failed_attempt' }],
  ['Parcel accepted in the unclaimed cargo area', { status: 'exception', stage: 'exception' }],
  // A leg into Canada. Yanwen's terminal tenders the parcel to the line-haul minutes after its
  // outbound scan, before the export release, so the tender is no delivery round. Then the
  // release from customs, the partner's arrival and the delivering carrier's intake and terminals,
  // until its driver loads the parcel for the round, which Yanwen files as out for delivery.
  ['Tendered for Delivery', { status: 'in_transit', stage: 'in_transit' }],
  ['Cleared Customs', { status: 'in_transit', stage: 'in_transit' }],
  ['Scanned arrived at FB Canada', { status: 'in_transit', stage: 'in_transit' }],
  ['Received from Prior Carrier', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at Terminal Location', { status: 'in_transit', stage: 'in_transit' }],
  ['Loaded on Truck', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  // A leg into Turkey, each line a scan in plain words and the postal event it records, from the dispatch
  // through the destination post and import customs to the collection point that holds the parcel for pickup.
  ['Shipment sent from destination transit centre,Despatched to overseas', { status: 'in_transit', stage: 'in_transit' }],
  ['Shipment received at Post Office,Arrival at Destination Post', { status: 'in_transit', stage: 'in_transit' }],
  ['Shipment arrived at overseas hub/ branch,Arrival at Processing Center', { status: 'in_transit', stage: 'in_transit' }],
  ['IN TRANSIT,Present to Import Customs', { status: 'in_transit', stage: 'customs' }],
  ['Shipment released from customs/ government check point,Released from Custom', { status: 'in_transit', stage: 'in_transit' }],
  ['Shipment hold for collection,Receive item at collection point for pick-up', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  // La Poste's own sentences on a parcel bound for France, read as La Poste's map reads their codes: its
  // platforms and the local sort in transit, the sort into the morning's round (DISTOU/MD1) out for delivery.
  ['Votre colis est en transit sur nos plateformes logistiques.', { status: 'in_transit', stage: 'in_transit' }],
  ['Votre Colissimo est en cours de traitement sur le site de tri local.', { status: 'in_transit', stage: 'in_transit' }],
  ['Votre colis est sur son site de distribution. Nous le préparons pour le mettre en livraison.', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  // A forwarder's leg after Yanwen's outbound scan, worded as First Line's and read as its map reads them: the
  // warehouse scans, China's export declaration before the flight, the landing and import release, the broker handing
  // the parcel to GOFO, then GOFO's hubs. GOFO loads the truck minutes before the hub's departure scan: no round yet.
  // Then GOFO's delivery station receives the parcel and sends it out on its round.
  ['Barcode scanning', { status: 'in_transit', stage: 'in_transit' }],
  ['Packaged', { status: 'in_transit', stage: 'in_transit' }],
  ['Leaving Scan', { status: 'in_transit', stage: 'in_transit' }],
  ['Export customs declaration completed', { status: 'in_transit', stage: 'in_transit' }],
  ['Hand over to airline', { status: 'in_transit', stage: 'in_transit' }],
  ['Next stop destination airport', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at destination airport', { status: 'in_transit', stage: 'in_transit' }],
  ['The package has been cleared through customs', { status: 'in_transit', stage: 'in_transit' }],
  ['Customs broker picked it up', { status: 'in_transit', stage: 'in_transit' }],
  ['The package has been transferred to the service provider', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at GOFO Regional Hub', { status: 'in_transit', stage: 'in_transit' }],
  ['Loaded on Vehicle', { status: 'in_transit', stage: 'in_transit' }],
  ['Departed GOFO Regional Hub', { status: 'in_transit', stage: 'in_transit' }],
  ['In Transit to Next Facility', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at GOFO Delivery Station', { status: 'in_transit', stage: 'in_transit' }],
  ['Out for Delivery', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  // A destination courier's transit hub, its delivery task and its sorting, after the import release and the pickup at
  // the destination port, and Poste Italiane's first scan after Yanwen's batch handover: the journey going on.
  ['ARRIVE TRANSITHUB', { status: 'in_transit', stage: 'in_transit' }],
  ['TASK ASSIGNED', { status: 'in_transit', stage: 'in_transit' }],
  ['ORDER SORTED', { status: 'in_transit', stage: 'in_transit' }],
  ['First parcel scan along Poste Italiane’s logistic network', { status: 'in_transit', stage: 'in_transit' }],
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

// The timeline marks the delivery scan with its LM40 milestone icon, whatever
// wording the last-mile carrier used for it.
const DELIVERY_ICON = 'LM40';

// Partner wording can prefix its facility in full-width brackets, or its
// country's code and a dot: "UA.In the New Post Office". Removing those
// observed prefixes makes the remaining exact wording reusable. A scan that is
// only the code keeps it.
const withoutPrefix = (description: string) => description.replace(/^【[^】]*】\s*/, '').replace(/^[a-z]{2}\.(?=\S)/i, '').trim();

// A partner's postal event can end with its country's code: "Arrival at Destination Post (Country: TR)".
const bare = (description: string) => withoutPrefix(description).replace(/\s*\(Country(?: code)?: [a-z]{2}\)$/i, '');

// J&T Express Australia's scans after Yanwen's batch handover at the destination port, relayed with its customer
// service line, are read as J&T's own map reads them, but its pickup is Yanwen's handover (`jAndTAuRelayedStage`).

/** A relayed scan's wording without J&T Australia's customer service line and the courtesy that offers it, as J&T's own adapter keeps neither. */
export const yanwenWording = (description: string): string => withoutCourtesy(description.replace(J_AND_T_AU_HOTLINE, '.')).trim();

// YWE's scans in the United States after Yanwen's batch handover at the destination port, relayed without YWE's codes:
// read as YWE's own map reads them, its hub's receipt of the container and of the parcel as that handover, in transit.
const yweRelayedStage = (wording: string): Stage | undefined => yweMappedStage(wording);

// China Post's domestic scans, which Yanwen relays in Chinese with the centre in 【】, read as China Post's own
// map reads them: "邮件离开【…】，正在发往下一站" in transit, the security check's "【…】退回" an exception. Then J&T
// Australia's, then YWE's.
const relayedStage = (normalized: string): Stage | undefined => chinaPostRelayedStage(normalized) ?? jAndTAuRelayedStage(normalized)
  ?? yweRelayedStage(normalized);

function relayedStatus(description: string): ClassifiedStatus | undefined {
  const stage = relayedStage(normalizeStatusWording(description));
  return stage ? { status: languageStageStatus(stage), stage } : undefined;
}

export function yanwenStatus(description: string, code?: string): ClassifiedStatus | undefined {
  if (code === DELIVERY_ICON) return { status: 'delivered', stage: 'delivered' };
  return WORDING.get(bare(description)) ?? relayedStatus(description);
}

const STAGE_BY_WORDING = new Map([...WORDING].map(([wording, { stage }]) => [normalizeStatusWording(wording), stage]));

// USPS's record of the label Yanwen made, relayed while Yanwen still has the parcel in China, at the
// label's US origin, DHL's record of the recipient's choice of a Packstation, and InPost's records of
// the sender's data and of the recipient's delivery choice: notices that move nothing and name no
// place the parcel has been.
const NOTICES = new Map([
  ['Shipping Label Created, USPS Awaiting Item', "USPS's record of the label Yanwen made for it, relayed while Yanwen still has the parcel: not a scan, so it keeps the stage the parcel already had."],
  ['The recipient has selected a Packstation as the new delivery address.', "DHL's record of the recipient's choice of a Packstation, relayed while the parcel can still be in China: not a scan, so it keeps the stage the parcel already had."],
  ['Pre-shipment Info sent to carrier', "InPost's record of the sender's data reaching it, relayed while Yanwen still has the parcel: not a scan, so it keeps the stage the parcel already had."],
  ['Preference applied', "InPost's record of the recipient's delivery choice, relayed while the parcel can still be in China: not a scan, so it keeps the stage the parcel already had."],
].map(([wording, note]) => [normalizeStatusWording(wording!), note!]));

/** Whether a scan is a notice: it keeps the stage of the scan before it and names no place. */
export const yanwenNotice = (description: string): boolean => NOTICES.has(normalizeStatusWording(withoutPrefix(description)));

/** What the map says about one scan by its milestone icon, the only code it keeps, else its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code === DELIVERY_ICON ? 'delivered' : STAGE_BY_WORDING.get(bare(wording)) ?? relayedStage(wording)),
  gaps: [
    { wording: 'ua.', note: "A partner's scan in Ukraine that Yanwen relays as its country's code alone, without words: it names no stage." },
    ...[...NOTICES].map(([wording, note]) => ({ wording, note })),
  ],
};

/** The parcel's status from the category on its identity field, for scans the map does not know. */
export function yanwenCategory(category: unknown): { status: CarrierStatus; stage?: Stage } | undefined {
  return typeof category === 'string' ? CATEGORY.get(category) : undefined;
}
