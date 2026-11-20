/**
 * DHL eCommerce Poland status vocabulary.
 *
 * The portal sends a status code and the step of its four-point timeline.
 * `statuses.json` holds the codes whose meaning the page script or a live
 * answer establishes. Any other code takes the stage of its timeline step.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { wording: string; stage?: Stage }

// The entries with a code are the API's statuses; the others are history scans.
const CODES = new Map<string, Entry>(statuses.entries.flatMap((entry) => 'code' in entry && entry.code
  ? [[entry.code, { wording: entry.wording, stage: entry.stage as Stage }] as const] : []));

// The timeline steps with the English labels the page gives them. `None` is a
// label that was created and not posted yet: it names no stage.
const TIMELINE: Record<string, Entry> = {
  None: { wording: 'Shipment preparation' },
  Sent: { wording: 'Posted', stage: 'registered' },
  Route: { wording: 'On its way', stage: 'in_transit' },
  Delivery: { wording: 'For delivery', stage: 'out_for_delivery' },
  Delivered: { wording: 'Delivered', stage: 'delivered' },
  ReturnToSender: { wording: 'Return to the Sender', stage: 'returned' },
  DeliveredToSender: { wording: 'Delivered to the Sender', stage: 'returned' },
  Resigned: { wording: 'The sender has requested the withdrawal of the shipment', stage: 'exception' },
  Error: { wording: 'Error', stage: 'exception' },
};

const STATUSES: Record<Stage, CarrierStatus> = {
  pending: 'pending', registered: 'pending', accepted: 'in_transit', in_transit: 'in_transit', customs: 'in_transit',
  ready_for_pickup: 'in_transit', out_for_delivery: 'out_for_delivery', delivered: 'delivered',
  failed_attempt: 'exception', returned: 'exception', exception: 'exception',
};

export interface DhlEcommercePlStatus { description: string; stage?: Stage }

// The sentence for a parcel a DHL BOX locker or DHL POP point holds, which stays on the timeline's "For delivery".
const WAITING = /^Przesyłka czeka na odbiór\.?$/i;

/** `text` is the sentence the answer carries for the status, when it has one. */
export function dhlEcommercePlStatus(code: string, timelineStep: unknown, text = ''): DhlEcommercePlStatus {
  const known = CODES.get(code);
  const step = typeof timelineStep === 'string' && Object.hasOwn(TIMELINE, timelineStep) ? TIMELINE[timelineStep] : undefined;
  const stage = known?.stage ?? (WAITING.test(text) ? 'ready_for_pickup' : step?.stage);
  const words = code.replaceAll('_', ' ').toLowerCase();
  return { description: text || known?.wording || step?.wording || words.charAt(0).toUpperCase() + words.slice(1), ...(stage ? { stage } : {}) };
}

export function statusForStage(stage: Stage): CarrierStatus {
  return STATUSES[stage];
}

// The history page's scan wording, in English or Polish, with the stage each names.
const SCAN_STAGES: readonly [RegExp, Stage][] = [
  [/^(?:Delivered to customer\.|Przesyłka doręczona do Odbiorcy\.)$/i, 'delivered'],
  [/^(?:With delivery courier|Przesyłka przekazana kurierowi do doręczenia)\.?(?: Expected delivery hours: \d{1,2}:\d{2}-\d{1,2}:\d{2}\.)?$/i, 'out_for_delivery'],
  [/^(?:The shipment is in transit to the delivery depot\.|Przesyłka w transporcie do oddziału doręczającego\.)$/i, 'in_transit'],
  [/^(?:The shipment has arrives at sorting center\.|Przesyłka została przyjęta w centrum sortowania\.)$/i, 'in_transit'],
  [/^(?:The shipment is processed at depot of origin country\.|Przesyłka jest obsługiwana w oddziale nadającym\.)$/i, 'in_transit'],
  [/^(?:The shipment has been dropped off at depot by the sender\.|Przesyłka została nadana przez nadawcę w oddziale DHL\.)$/i, 'accepted'],
  // Sorting on the way, at a hub and again at the delivery depot, which the page words two ways in English.
  [/^(?:The shipment is handled in Sorting Center|The shipment is processed at sorting center|Przesyłka jest obsługiwana w Centrum Sortowania)\.?$/i, 'in_transit'],
  [/^(?:The shipment has reached DHL terminal\.|Przesyłka dotarła do oddziału nadawczego DHL Parcel\.)$/i, 'accepted'],
  // A terminal that gives the planned delivery day is reached on the way, with the sorting centre's scan.
  [/^(?:The shipment has reached DHL terminal(?: in [^.]{0,80})?\. Planned date of delivery to|Przesyłka dotarła do oddziału nadawczego DHL Parcel(?: [^.]{1,80})?\. Przewidywana data doręczenia do): \d{1,2}-\d{1,2}-\d{4}\.$/i, 'in_transit'],
  // A terminal named on the way, after the first one.
  [/^(?:The shipment has reached DHL Terminal (?!in )[^.]{1,80}|Przesyłka dotarła do oddziału DHL eCommerce [^.]{1,80})\.?$/i, 'in_transit'],
  // The delivery depot, with the day the courier will take the parcel and, for today, the hours.
  [/^(?:The shipment has reached DHL Terminal(?: [^.]{1,80})?\. Delivery to the Recipient is expected (?:today|on the next working day)\.(?: Delivery hours: from \d{1,2}:\d{2} to \d{1,2}:\d{2}\.)?|Przesyłka dotarła do (?:oddziału DHL eCommerce|Terminala DHL Parcel)(?: [^.]{1,80})?\. (?:Doręczenie do Odbiorcy planowane jest w kolejnym dniu roboczym|W dniu dzisiejszym zostanie przekazana Kurierowi DHL Parcel do doręczenia)\.(?: Planowane godziny doręczenia: od \d{1,2}:\d{2} do \d{1,2}:\d{2}\.)?)$/i, 'in_transit'],
  // A parcel sent abroad: its first terminal, named without a delivery day, then the way out.
  [/^The shipment has reached DHL terminal in [^.]{0,80}\.$/i, 'accepted'],
  [/^The shipment left the origin country\.?$/i, 'in_transit'],
  // A parcel leaving the gateway, on its way out or coming back after a failed delivery abroad.
  [/^The shipment has left the gateway in origin country\.$/i, 'in_transit'],
  [/^The shipment has arrived at gateway in destination country\.$/i, 'in_transit'],
  [/^(?:The shipment has arrived at delivery depot|Przesyłka przyjęta w oddziale doręczającym)\.$/i, 'in_transit'],
  // A notice of the delivery day to the recipient, which moves nothing.
  [/^The recipient was informed about the date of delivery\.$/i, 'pending'],
  // The recipient's instruction to leave the parcel in a safe place, which moves nothing either.
  [/^(?:According to consignee request the parcel will be delivered to the safe place|Odbiorca złożył dyspozycję dot\. doręczenia przesyłki do bezpiecznego miejsca doręczenia)\.$/i, 'pending'],
  [/^(?:The shipment (?:has been|was) delivered to the recipient|Przesyłka została doręczona do odbiorcy)\.$/i, 'delivered'],
  // The courier found nobody: a DHL POP point or locker nearby will hold the parcel.
  [/^(?:DHL Courier did not reach the Recipient at the indicated delivery address\. The shipment will be waiting for collection in DHL POP in the nearest area|Kurier DHL nie zastał Odbiorcy pod wskazanym adresem doręczenia\. Przesyłka będzie oczekiwać na odbiór w Punkcie DHL POP \/ Automacie DHL POP BOX w najbliższej okolicy)\.$/i, 'failed_attempt'],
  // The recipient refused the parcel, or left it uncollected, and it goes back: a return under way, then its end.
  [/^(?:The Recipient has refused to accept the shipment and it will be returned to the Sender|Odbiorca odmówił przyjęcia przesyłki i zostanie ona zwrócona do Nadawcy)\.?$/i, 'exception'],
  [/^(?:Shipment returned do sender\. Time for receipt has passed|Zwrot przesyłki do nadawcy - minął termin odbioru)\.?$/i, 'exception'],
  [/^(?:Delivery in the way to the Sender|Przesyłka w trakcie zwrotu do Nadawcy)\.?$/i, 'exception'],
  [/^(?:The shipment was returned to the Sender|Przesyłka została zwrócona do nadawcy)\.$/i, 'returned'],
  // The destination's notice that a wrong address stopped the delivery: the parcel goes back to its sender.
  [/^The shipment couldn['’]t be delivered because of bad\/incorrect address and will be returned to the sender\.$/i, 'exception'],
  // On the way from the delivery depot to the DHL BOX locker or DHL POP point that will hold the parcel.
  [/^Delivery in the way to the DHL Point\.?$/i, 'in_transit'],
  // The DHL BOX locker or DHL POP point holding the parcel for its recipient, with its address and hours.
  [/^(?:Shipment is waiting in|Przesyłka oczekuje na odbiór w) .{1,300}$/i, 'ready_for_pickup'],
  [WAITING, 'ready_for_pickup'],
  // Its recipient collected the parcel from that locker or point.
  [/^Shipment collected from DHL (?:Parcelstation|POP|Point|BOX)\b.{0,120}$/i, 'delivered'],
];

/** Which of the map's scans a wording is, in English or Polish: one number for a scan in either language. */
export function dhlPolandScanKind(description: string): number | undefined {
  const index = SCAN_STAGES.findIndex(([pattern]) => pattern.test(description));
  return index < 0 ? undefined : index;
}

/** The stage of one history scan's wording, once the recipient's acknowledgement is cut off. */
export function dhlPolandScanStage(description: string): Stage | undefined {
  return SCAN_STAGES.find(([pattern]) => pattern.test(description))?.[1];
}

/**
 * What the map says about one scan: the history page's wording, as the browser step reads it.
 * The API's current status is a summary, not a scan, so its wording stays open.
 */
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => dhlPolandScanStage(wording), gaps: [] };
