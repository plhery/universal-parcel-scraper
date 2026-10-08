/**
 * DPD Switzerland status vocabulary.
 *
 * Three sources have to agree here. The myDPD guest API answers with a
 * `parcelHistory[].description` / `status.description` enumeration
 * (`DELIVERED`, `AVAILABLE_FOR_COLLECTION`, ...), which is the reliable key. A
 * verified-postcode lookup adds `parcelEvents[].eventType` scan codes (`DEY`,
 * `DLO`, ...). The rendered consignee page has no codes at all, only
 * translated prose, so the page fallback is classified by wording in four
 * languages.
 *
 * Only the values whose meaning is unambiguous receive an explicit stage.
 * `PARCEL_HANDED`, `IN_TRANSIT` and `AT_DELIVERY_CENTER` deliberately yield no
 * stage: they move the result status to `in_transit` but leave the event
 * unmapped so the sync's classifier records the wording for review instead of
 * this map inventing a milestone. Scan codes are mapped where a live lookup
 * paired them with an enumeration value, or where DPD's own label names one
 * movement inside its network (see `scanStage`). `statusMap` lists the codes
 * and labels left unmapped on purpose.
 *
 * Provenance: the enumeration, the scan codes and their English labels are
 * what the myDPD guest API returns for Swiss consignee lookups; the wording
 * lists come from the public tracking page in en/de/fr/it.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import { deliveryForecastRemainder } from '../../core/status/language.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** English labels for the guest API enumeration, used when the API sends no translation. */
export const API_LABELS: Record<string, string> = {
  ORDER_CREATED: 'Order created',
  PARCEL_HANDED: 'Parcel handed to DPD',
  IN_TRANSIT: 'Your parcel is on its way',
  AT_DELIVERY_CENTER: 'At delivery center',
  RETURN_TO_SENDER: 'Return to sender',
  PARCEL_OUT_FOR_DELIVERY: 'Parcel out for delivery',
  AVAILABLE_FOR_COLLECTION: 'Ready for collection',
  UNSUCCESSFUL_DELIVERY_ATTEMPT: 'Unsuccessful delivery attempt',
  DELIVERED: 'Delivered',
  OTHER: 'Other tracking update',
};

/** Wording classifier for the rendered page, which carries no status codes. */
export function wordingStatus(text: string, hasEvents: boolean): CarrierStatus {
  // A delivery notice ("will be delivered on Tuesday") is not a delivery.
  const value = (deliveryForecastRemainder(text) ?? text).toLocaleLowerCase('en-US');
  if (['failed', 'not delivered', 'unable', 'problem', 'retour', 'returned']
    .some((term) => value.includes(term))) return 'exception';
  if (['delivered', 'zugestellt', 'livré', 'consegnato']
    .some((term) => value.includes(term))) return 'delivered';
  if (['out for delivery', 'delivery today', 'in zustellung', 'en cours de livraison']
    .some((term) => value.includes(term))) return 'out_for_delivery';
  if (hasEvents || ['handed to dpd', 'on its way', 'arrived', 'depot', 'network']
    .some((term) => value.includes(term))) return 'in_transit';
  if (['data received', 'information received', 'announced', 'übergeben']
    .some((term) => value.includes(term))) return 'pending';
  return 'unknown';
}

/** The result status for a guest API enumeration value, falling back to the wording. */
export function apiStatus(description: unknown, statusText: string, hasEvents: boolean): CarrierStatus {
  const key = typeof description === 'string' ? description.trim().toUpperCase() : '';
  if (key === 'DELIVERED') return 'delivered';
  if (['PARCEL_OUT_FOR_DELIVERY', 'AVAILABLE_FOR_COLLECTION'].includes(key)) {
    return 'out_for_delivery';
  }
  if (['RETURN_TO_SENDER', 'UNSUCCESSFUL_DELIVERY_ATTEMPT'].includes(key)) {
    // A failed attempt is a retry, not terminal; a return is terminal but
    // stays in the exception status with a returned stage (no returning status).
    return key === 'RETURN_TO_SENDER' ? 'exception' : 'in_transit';
  }
  if (key === 'ORDER_CREATED') return 'pending';
  if (['PARCEL_HANDED', 'IN_TRANSIT', 'AT_DELIVERY_CENTER'].includes(key)) return 'in_transit';
  return wordingStatus(statusText, hasEvents);
}

/** The stage for a guest API enumeration value, or null when the value is not mapped. */
export function apiStage(description: unknown): Stage | null {
  const key = typeof description === 'string' ? description.trim().toUpperCase() : '';
  if (key === 'AVAILABLE_FOR_COLLECTION') return 'ready_for_pickup';
  if (key === 'PARCEL_OUT_FOR_DELIVERY') return 'out_for_delivery';
  if (key === 'RETURN_TO_SENDER') return 'returned';
  if (key === 'UNSUCCESSFUL_DELIVERY_ATTEMPT') return 'failed_attempt';
  if (key === 'ORDER_CREATED') return 'registered';
  if (key === 'DELIVERED') return 'delivered';
  return null;
}

/**
 * `parcelEvents[].eventType` scan codes. On 2026-09-26 a verified lookup
 * listed ORI, DLI, DLO and DEY at the same wall clock as the `parcelHistory`
 * enumeration named beside them. CCO has no twin; it ends customs clearance.
 * HUI, HUS, DLS and DLQ are the hub and delivery-depot scans a verified
 * domestic history lists between ORI and DLO, each labelled with one movement.
 * ORI ("Origin depot - In") stays unmapped like its twin PARCEL_HANDED: the
 * result stage then comes from the same wording as the scan's, and an import
 * that cleared customs does not step back to accepted. Other codes stay
 * unmapped.
 */
const SCAN_STAGES: Readonly<Record<string, Stage>> = {
  CCO: 'in_transit', // "Customs - Out"
  HUI: 'in_transit', // "Your parcel arrived at our hub"
  HUS: 'in_transit', // "Your parcel is ready to be transported to our next premises"
  DLI: 'in_transit', // "Destination depot - Inbound", twin AT_DELIVERY_CENTER
  DLS: 'in_transit', // "Your parcel has been sorted and is ready for delivery"
  DLQ: 'in_transit', // "Your parcel is at our delivery depot, it will soon be on its way"
  DLO: 'out_for_delivery', // "Destination depot - Out for delivery", twin PARCEL_OUT_FOR_DELIVERY
  DEY: 'delivered', // "Delivery - Delivered", twin DELIVERED
};

/** The stage for a guest API scan code, or null when the code is not mapped. */
export function scanStage(code: string): Stage | null {
  return Object.hasOwn(SCAN_STAGES, code) ? SCAN_STAGES[code]! : null;
}

/**
 * "Delivery - Proof of delivery": DPD filing the proof minutes after DEY,
 * with no place. Paperwork, not a movement of the parcel.
 */
export const PROOF_OF_DELIVERY_SCAN = 'DEYY';

const MOVES_WITHOUT_MILESTONE = "DPD's map leaves it unmapped on purpose: it moves the parcel in transit without a milestone of its own.";

/**
 * What the map says about one scan. A scan code or an enumeration value is all
 * it reads: the rendered page's prose has no code and gets no stage here, and
 * a code staged by its enumeration twin depends on the reply, so it is not
 * answered by the code alone.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? scanStage(code) ?? apiStage(code) : null) ?? undefined,
  gaps: [
    { code: 'PARCEL_HANDED', note: MOVES_WITHOUT_MILESTONE },
    { code: 'IN_TRANSIT', note: MOVES_WITHOUT_MILESTONE },
    { code: 'AT_DELIVERY_CENTER', note: MOVES_WITHOUT_MILESTONE },
    { code: 'ORI', note: "DPD's map leaves it unmapped on purpose, like its twin PARCEL_HANDED, so an import that cleared customs does not step back to accepted." },
    { wording: 'parcel handed to dpd', note: "The label of PARCEL_HANDED, which DPD's map leaves unmapped on purpose." },
    { wording: 'your parcel is on its way', note: "The label of IN_TRANSIT, which DPD's map leaves unmapped on purpose." },
    { wording: 'at delivery center', note: "The label of AT_DELIVERY_CENTER, which DPD's map leaves unmapped on purpose." },
    { code: 'SPL', note: 'Worded like IN_TRANSIT and seen on both sides of the origin depot, so it names no movement of its own.' },
    { code: 'OTHER', note: "The guest API's catch-all, which names no movement." },
    { code: 'SPE', note: 'A delivery estimate or a changed delivery day, not a scan.' },
    { code: 'MSDLO', note: 'The notice DPD emailed for the delivery round, not a scan.' },
    { code: 'MIDLI', note: "The recipient's delivery instruction, not a scan." },
  ],
};
