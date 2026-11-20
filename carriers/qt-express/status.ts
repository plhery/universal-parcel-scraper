import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** One status of the tracker: the wording its page gives it in English and Hungarian, and its stage. */
interface QtStatus {
  readonly en: string;
  readonly hu: string;
  readonly stage: Stage;
}

// The statuses the tracker's script lists as steps, with its Hungarian translations; in English
// the page writes the status itself. A parcel sent back to the depot is not delivered again and
// waits there for its return to the sender.
const STATUSES: ReadonlyMap<string, QtStatus> = new Map<string, QtStatus>([
  ['ARRIVED TO REGIONAL DEPOT', { en: 'Arrived to regional depot', hu: 'Megérkezett a regionális raktárba', stage: 'in_transit' }],
  ['TRANSFER TO FINAL DEPOT', { en: 'Transfer to final depot', hu: 'Átszállítva a kiszállító raktárba', stage: 'in_transit' }],
  ['ARRIVED TO FINAL DEPOT', { en: 'Arrived to final depot', hu: 'Megérkezett a kiszállító raktárba', stage: 'in_transit' }],
  ['LAST MILE DELIVERY PROCESSING', { en: 'Last mile delivery processing', hu: 'Kézbesítés folyamatban', stage: 'out_for_delivery' }],
  ['WAITING FOR CUSTOMER PICKUP', { en: 'Waiting for customer pickup', hu: 'Ügyfél általi átvételre vár', stage: 'ready_for_pickup' }],
  ['DELIVERED', { en: 'Delivered', hu: 'Kézbesítve', stage: 'delivered' }],
  ['RETURNED TO DEPOT', { en: 'Returned to depot', hu: 'Visszaküldve a raktárba', stage: 'exception' }],
  ['RETURNED TO SENDER', { en: 'Returned to sender', hu: 'Visszaküldve a feladónak', stage: 'returned' }],
  ['DELIVERY FAILED', { en: 'Delivery failed', hu: 'Sikertelen kézbesítés', stage: 'failed_attempt' }],
  ['DAMAGED', { en: 'Damaged', hu: 'Sérült', stage: 'exception' }],
  ['LOST', { en: 'Lost', hu: 'Elveszett', stage: 'exception' }],
  ['DESTROYED IN TRANSPORT', { en: 'Destroyed in transport', hu: 'Szállítás közben megsemmisült', stage: 'exception' }],
  ['CANCELLED', { en: 'Cancelled', hu: 'Törölve', stage: 'exception' }],
]);

// Why a delivery failed: the script's codes, the service's English text for each and the page's
// Hungarian one. `WRITE_SOMETHING_ELSE` stands for a reason the courier typed, which the page leaves out.
const REASONS: ReadonlyMap<string, { en: string; hu: string | null }> = new Map([
  ['CUSTOMER_IS_NOT_AVAILABLE', { en: 'Customer is not available', hu: 'Az ügyfél nem elérhető' }],
  ['INCORRECT_PHONE_NUMBER', { en: 'Incorrect Phone Number', hu: 'Hibás telefonszám' }],
  ['INCORRECT_CUSTOMER_ADDRESS', { en: 'Incorrect Customer Address', hu: 'Hibás cím' }],
  ['CUSTOMER_REQUEST_DELIVERY_ANOTHER_TIME', { en: 'Customer requests delivery another time', hu: 'Az ügyfél más időpontot kér' }],
  ['CUSTOMER_REQUESTS_PICKUP_POINT_COLLECTION', { en: 'Customer requests pickup point collection', hu: 'Az ügyfél átvételi pontra kéri' }],
  ['CUSTOMER_REJECTS_DELIVERY', { en: 'Customer rejects delivery', hu: 'Az ügyfél megtagadta az átvételt' }],
  ['CUSTOMER_UNABLE_TO_PAY', { en: 'Customer unable to pay', hu: 'Az ügyfél nem tud fizetni' }],
  ['SENDER_CANCELLED_DELIVERY', { en: 'Sender cancelled delivery', hu: 'A feladó lemondta a kézbesítést' }],
  ['DELIVERY_POSTPONED', { en: 'Delivery postponed', hu: 'Kézbesítés elhalasztva' }],
  ['FORCE_MAJEURE', { en: 'Force Majeure', hu: 'Vis maior' }],
  ['PARTIALLY_LOST', { en: 'Partially Lost', hu: 'Részben elveszett' }],
  ['LOST', { en: 'Lost', hu: 'Elveszett' }],
  ['DAMAGE', { en: 'Damaged', hu: 'Sérült' }],
  ['DELIVERY_FAILED_DUE_TO_SERVICE_PROVIDER', { en: 'Delivery failed due to the service provider', hu: 'Szolgáltatói okból sikertelen' }],
  ['OTHER_THAN_SERVICE_PROVIDER', { en: 'Other than service provider', hu: 'Nem szolgáltatói ok' }],
  ['WRITE_SOMETHING_ELSE', { en: 'Write something else...', hu: null }],
  ['DUE_TO_TECHNICAL_REASON', { en: 'Due to technical reason', hu: 'Technikai hiba miatt nem sikerült kézbesíteni' }],
  ['CUSTOMER_CHANGED_ADDRESS', { en: 'Customer changed the address', hu: 'Cím módosítás történt' }],
]);
const REASON_BY_TEXT = new Map([...REASONS].map(([code, { en }]) => [en, code]));

/** A status's wordings and stage, or undefined for one the tracker's script does not list. */
export function qtStatus(name: string): QtStatus | undefined {
  return STATUSES.get(name);
}

/**
 * The reason of a failed delivery as the page words it: by the event's reason code, else by the
 * service's English text for one, else the text as written. A typed reason has no wording.
 */
export function qtFailureReason(code: unknown, text: string, language: 'en' | 'hu'): string {
  const known = [typeof code === 'string' ? code : '', REASON_BY_TEXT.get(text) ?? ''].find(name => REASONS.has(name));
  if (!known) return text;
  const reason = REASONS.get(known)!;
  return reason.hu === null ? '' : (language === 'hu' ? reason.hu : reason.en);
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? STATUSES.get(code)?.stage : undefined),
  gaps: [],
};
