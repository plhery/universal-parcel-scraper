/**
 * Swiss Post status classification.
 *
 * Two independent vocabularies meet here. `status.status` is the item-level
 * summary the tracker shows at the top of its page. Event codes, bare or as the
 * last segment of a stored dotted code such as `PARCEL.*.1.1003`, are the
 * authority for the current stage: the summary lags behind (a MyPost24 deposit
 * reads `DELIVERED` while the parcel is still waiting in the locker).
 *
 * Only codes with a confirmed meaning are mapped. Anything else is left without
 * a stage so the sync can classify the wording and record the code for review.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import type { Stage } from '../../generated/catalog.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** Item-level `status.status` → status. The event codes below refine it. */
export const STATUS_MAP = new Map<string, CarrierStatus>([
  ['NOT_YET_SENT', 'pending'],
  ['ON_GOING_DELIVERY', 'in_transit'],
  ['WAITING_FOR_PICKUP', 'in_transit'],
  ['DELIVERED', 'delivered'],
  ['RETURNED', 'exception'],
]);

/** Wording for scans that come without any. */
export const FALLBACK_EVENT_LABELS: Record<string, string> = {
  '600': 'Your shipment will shortly be handed over to Swiss Post',
  '1003': 'Loading into delivery vehicle',
  '1201': 'Sorted for delivery',
  '1202': 'Shipment was sorted',
};

/**
 * Event codes (the last dotted segment) with a confirmed stage. Swiss Post's
 * own wording table gives each code one meaning for parcels and letters alike,
 * domestic or international, so one table serves every source and product.
 */
export const EVENT_STAGE_BY_CODE: Record<string, Stage> = {
  '100': 'accepted',
  '200': 'accepted',
  '400': 'in_transit',
  '500': 'accepted',
  // Pickups at the client, like 500, in Swiss Post's own wording table.
  '501': 'accepted',
  '502': 'accepted',
  '600': 'registered',
  '620': 'registered',
  '803': 'customs',
  '804': 'in_transit',
  '805': 'in_transit',
  '813': 'in_transit',
  '815': 'in_transit',
  '818': 'in_transit',
  '819': 'customs',
  '820': 'in_transit',
  '842': 'customs',
  '847': 'in_transit',
  '854': 'registered',
  '859': 'registered',
  '902': 'customs',
  '904': 'in_transit',
  '906': 'in_transit',
  '908': 'in_transit',
  '909': 'in_transit',
  '910': 'ready_for_pickup',
  '912': 'accepted',
  '913': 'in_transit',
  '915': 'in_transit',
  '918': 'in_transit',
  '919': 'customs',
  '920': 'in_transit',
  '921': 'in_transit',
  '923': 'failed_attempt',
  '924': 'failed_attempt',
  '926': 'ready_for_pickup',
  '934': 'failed_attempt',
  '938': 'delivered',
  // An outbound item's export clearance and its completion: routine steps before it leaves Switzerland.
  '942': 'in_transit',
  '947': 'in_transit',
  '1000': 'in_transit',
  '1001': 'in_transit',
  '1002': 'in_transit',
  '1003': 'out_for_delivery',
  '1004': 'in_transit',
  '1100': 'in_transit',
  '1200': 'in_transit',
  '1201': 'in_transit',
  '1202': 'in_transit',
  '1204': 'in_transit',
  '1213': 'in_transit',
  '1218': 'in_transit',
  // Sorted and sent on, and its arrival at a special delivery base, between two delivery rounds.
  '1300': 'in_transit',
  '1400': 'in_transit',
  // More sorting, and the item moved to general cargo, in Swiss Post's own wording table.
  '1302': 'in_transit',
  '1303': 'in_transit',
  '1304': 'in_transit',
  '1401': 'in_transit',
  // Handed to the recipient at a post office counter.
  '2000': 'delivered',
  // A pickup notice like 910: the item waits at a post office for collection.
  '2100': 'ready_for_pickup',
  '2101': 'ready_for_pickup',
  '2102': 'ready_for_pickup',
  '3401': 'returned',
  '3501': 'in_transit',
  '3502': 'in_transit',
  '3600': 'returned',
  '3601': 'returned',
  '3602': 'returned',
  // The recipient's refusal. Sending the item back is a later scan of its own.
  '3700': 'exception',
  '3800': 'delivered',
  '3900': 'delivered',
  '3901': 'delivered',
  '4000': 'delivered',
  '4001': 'delivered',
  '4002': 'delivered',
  '4003': 'delivered',
  '4020': 'in_transit',
  // After the item was loaded into the delivery vehicle; a later round follows.
  '4100': 'failed_attempt',
  // Delivered, worded as 4000 is, and the only delivery scan of a parcel that has it.
  '4200': 'delivered',
  '4600': 'delivered',
  '5500': 'ready_for_pickup',
  '6300': 'ready_for_pickup',
  // Held at a post office for the recipient to collect, as poste restante.
  '9400': 'ready_for_pickup',
};

/** The shipment status implied by the newest event's stage. */
export const STAGE_STATUS: Record<string, CarrierStatus> = {
  registered: 'pending',
  accepted: 'in_transit',
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  customs: 'in_transit',
  exception: 'exception',
  failed_attempt: 'exception',
  ready_for_pickup: 'in_transit',
  returned: 'exception',
};

/**
 * The stage for an event code, bare or dotted, or undefined when the code is
 * not mapped. A revoked scan takes none: the caller checks its wording
 * (`swissPostRevoked`).
 */
export function swissPostEventStage(eventCode: string): Stage | undefined {
  return EVENT_STAGE_BY_CODE[eventCode.split('.').at(-1) ?? ''];
}

/** The stage the item-level `status.status` implies, used when the newest scan has none. */
export const GLOBAL_STATUS_STAGE: Record<string, Stage> = {
  NOT_YET_SENT: 'registered',
  ON_GOING_DELIVERY: 'in_transit',
  WAITING_FOR_PICKUP: 'ready_for_pickup',
  DELIVERED: 'delivered',
  RETURNED: 'returned',
};

/** The former tracker's summary codes, which status-only answers stored before carry as their text. */
const FORMER_GLOBAL_STATUSES = ['REPORTED', 'REGISTERED', 'TO_BE_DELIVERED', 'IN_DELIVERY', 'MISSED_DELIVERY', 'NOT_DELIVERED', 'CUSTOMS'];

/**
 * The summary codes a status-only answer carries as its status text: the tracker's, its
 * `UNKNOWN`, and the former tracker's.
 */
export const SWISS_POST_GLOBAL_STATUSES: readonly string[] = Object.freeze([
  ...Object.keys(GLOBAL_STATUS_STAGE), 'UNKNOWN', ...FORMER_GLOBAL_STATUSES,
]);

/** The languages the tracker words its scans in; it answers any other in German. */
export const SWISS_POST_LANGUAGES = ['en', 'de', 'fr', 'it'] as const;
export type SwissPostLanguage = (typeof SWISS_POST_LANGUAGES)[number];

/** A revoked scan's wording ends with its sub-event's label, in any of the tracker's languages. */
const REVOKED = /— (?:revocation|révocation|widerruf|revoca)$/i;

/** Whether a scan's wording is that of a revoked scan ("Delivered — Revocation", "Distribué — Révocation"). */
export function swissPostRevoked(wording: string): boolean {
  return REVOKED.test(wording.trim());
}

/**
 * What the map says about one scan. The map reads the last segment of the
 * dotted event code. A revoked scan takes no stage.
 */
export const statusMap: CarrierStatusMap = {
  codeKey: (code) => code.split('.').at(-1) ?? code,
  stage: (code, wording) => (code && !swissPostRevoked(wording) ? swissPostEventStage(code) : undefined),
  gaps: [
    { code: '9112', note: 'An enquiry note, not a movement: the shipment summary decides the stage.' },
    { code: '1800', note: 'A delay notice, not a movement: the shipment summary decides the stage.' },
    { code: '9224', note: "The recipient's order to forward the shipment, not a movement: the shipment summary decides the stage." },
    { code: '811', note: "The destination country's import process cancelled: no source says whether the item goes on or its import failed, so the shipment summary decides the stage." },
  ],
};
