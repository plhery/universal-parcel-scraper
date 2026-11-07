/**
 * DHL wording → product stage.
 *
 * DHL's public `/int-verfolgen/data` payload carries no status code: the
 * shipment history is free text in the language the lookup asks for, English
 * or German, so this map is a wording classifier rather than a code table. The
 * German wording is not a translation of the English: DHL words some scans
 * apart, such as a parcel being prepared for the delivery vehicle, which in
 * English is processed in the delivery base. Rules are
 * ordered so that a negative, a forecast or a handoff wins before the broad
 * delivery words, and anything unrecognized keeps the caller's fallback
 * instead of inventing progress.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import { trackingLanguageStage, type Stage } from '../../core/status/index.js';
import { nonterminalEnglishReturn } from '../../core/status/language.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The recipient's booked receiving option ("Für diese Sendung wurde ein Liefertag als
 * Empfangsoption vorgemerkt."): a wish, not a movement. The parser leaves it out, as Hermes
 * Germany's booked delivery day; read as unmapped wording, it came as transit.
 */
export const BOOKED_OPTION = /\bals empfangsoption vorgemerkt\b/i;

/**
 * A redirect DHL refused ("Die Paketumleitung wurde aufgrund Produkt/Service-Kombination nicht
 * erlaubt storniert. Die Sendung wird an die Hausadresse zugestellt."): a notice, not a delivery
 * attempt, so the parcel keeps the stage it had.
 */
export const REFUSED_REDIRECT = /\bpaketumleitung wurde\b[^.]*\bstorniert\b/i;

/**
 * A Packstation as the parcel's address ("Sendung auf dem Weg zur Packstation."): DHL writes it
 * beside the loading onto the delivery vehicle, and also when a redirect sends the parcel to a
 * Packstation, which can take another day. It says where the parcel goes, not how far it got, so
 * it keeps the stage of the scan before it: read as transit, it undid an out-for-delivery scan.
 */
export const PACKSTATION_ADDRESS = /\bauf dem weg zur packstation\b/i;

/** A notice that keeps the stage of the scan before it. */
export function keepsStage(text: string): boolean {
  return REFUSED_REDIRECT.test(text) || PACKSTATION_ADDRESS.test(text);
}

/**
 * DHL's pre-advice: the sender's electronic data ("Die Sendung wurde elektronisch angekündigt.",
 * "The instruction data … provided … electronically"). Listed after a scan that moved the parcel,
 * it is a notice, not movement, and the parser leaves it out.
 */
export function preAdvice(text: string): boolean {
  return /\belectronically\b|\belektronisch\b/i.test(text) && stageForText(text, '') === 'registered';
}

const MOVED = new Set(['accepted', 'in_transit', 'out_for_delivery', 'failed_attempt', 'ready_for_pickup', 'delivered', 'returned']);

/** Stages of the scans that carry the parcel back once its return started. */
const RETURN_TRIP: ReadonlySet<string> = new Set(['in_transit', 'customs']);

/**
 * The scans, newest first, that carry the parcel back after DHL's latest return start: the moves
 * since it, while nothing else came after it. A round, a failed attempt or a delivery after the
 * return ends it, and the moves before that went to the recipient again.
 */
export function returnTrip(stages: readonly (string | undefined)[]): number {
  const moves = stages.findIndex((stage) => !RETURN_TRIP.has(stage ?? ''));
  return moves > 0 && stages[moves] === 'returned' ? moves : 0;
}

/** Whether the wording reads as a step that moved the parcel; unknown wording does not. */
export function movedParcel(text: string): boolean {
  return MOVED.has(stageForText(text, ''));
}

/**
 * The return starting or under way: "The shipment is returned to the sender" after a failed round,
 * the English of "wird … an den Absender zurückgesandt", "is returning to sender" and "auf dem Weg
 * zurück zum Absender". The parcel goes back from here, so it is returned, as the scans after it
 * that carry it back are (`returnTrip`).
 */
const RETURN_UNDER_WAY = /\bis (?:being )?returned to (?:the )?sender\b|\bis returning to (?:the )?sender\b|\bauf dem weg zurück zum absender\b|\bwird\b[^.]*\bzurück(?:gesandt|geschickt)\b/;

export function stageForText(text: string, fallback = 'in_transit'): string {
  const value = text.toLowerCase();
  if (RETURN_UNDER_WAY.test(value)) return 'returned';
  // A return still to come, such as a parcel left uncollected past its storage period: the parcel
  // has not started back yet, so it is an exception, never its acceptance or the return itself.
  if (nonterminalEnglishReturn(text) || /\bwill be (?:returned|sent back)\b|\bnot (?:been )?picked up\b|\bwird\b[^.]*\bzurück|auf dem weg zurück|\bnicht\b[^.]*\babgeholt\b/.test(value)) return 'exception';
  if (/returned to (?:the )?sender|zurück.*absender|rücksendung|retour/.test(value)) return 'returned';
  // "Delivery not possible" comes after the loading onto the delivery vehicle, before the parcel
  // waits at a retail outlet: a failed attempt, as the partner posts' copies of the scan read it.
  // So is a recipient the courier could not find at the address on the parcel.
  if (/not delivered|could not be delivered|unable to deliver|delivery attempt|delivery (?:was )?not possible|recipient could not be found\b|\bnicht\b[^.]*\bzugestellt\b|zustellversuch|nicht angetroffen/.test(value)) return 'failed_attempt';
  // GENERATED equivalents of DHL's existing forecast behavior: a forecast retains
  // the structured progress fallback; it cannot establish delivery or pre-advice.
  if (/will be delivered|sera livr[ée]|wird\s+(?!zugestellt\b).+zugestellt|sar[àa] consegnat/.test(value)) return fallback;
  // Still at the delivery base, "processed in the delivery base" in English: not yet on the vehicle.
  if (/für die verladung ins zustellfahrzeug vorbereitet/.test(value)) return 'in_transit';
  const translated = trackingLanguageStage(text);
  if (translated) return translated;
  if (/ready for (?:pickup|collection)|ready to (?:collect|pick up)|awaiting collection|abholbereit|zur abholung bereit|liegt zur abholung\b[^.]*\bbereit/.test(value)) return 'ready_for_pickup';
  // "Abholung aus Packstation": the recipient took the parcel out of the Packstation, as DHL's delivered flag says.
  if (/has been delivered|was delivered|successfully delivered|^delivered\b|erfolgreich zugestellt|wurde.*zugestellt|^abholung aus (?:der )?packstation\b/.test(value)) return 'delivered';
  if (/^being delivered[.!]?$|out for delivery|loaded (?:into|onto).*delivery vehicle|in das zustellfahrzeug geladen|in zustellung/.test(value)) return 'out_for_delivery';
  if (/customs clearance process\b[^.]*\bhas been completed\b/.test(value)) return 'in_transit';
  if (/customs|zoll/.test(value)) return 'customs';
  if (/electronically|elektronisch|label created|shipment information|instruction data/.test(value)) return 'registered';
  // A booked collection precedes "Pick-up was successful.", so it cannot be progress beyond it.
  if (/^pick-up has been scheduled\b/.test(value)) return 'registered';
  if (/will be transported to the destination country/.test(value)) return 'in_transit';
  if (/pick-up was successful|accepted|handed (?:over|to)|has been posted by the sender|eingeliefert|übergeben|^die sendung wurde (?:von dhl )?abgeholt\b/.test(value)) return 'accepted';
  if (/processed|sorted|sorting|sortierung|bearbeitet|briefzentrum|paketzentrum|transit|transport|arrived|eingetroffen|departed/.test(value)) return 'in_transit';
  return fallback;
}

export function statusForStage(stage: string): CarrierStatus {
  if (stage === 'registered' || stage === 'pending') return 'pending';
  if (stage === 'delivered') return 'delivered';
  if (stage === 'out_for_delivery' || stage === 'ready_for_pickup') return 'out_for_delivery';
  if (stage === 'failed_attempt' || stage === 'returned' || stage === 'exception') return 'exception';
  return 'in_transit';
}

/**
 * What the map says about one scan: DHL's scans carry no code, so their wording stages them as
 * the adapter reads it. Wording the rules do not know stays open, and so does a forecast, which
 * keeps the progress before it.
 */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => keepsStage(wording) ? undefined : (stageForText(wording, '') || undefined) as Stage | undefined,
  gaps: [],
  gapNote: (_code, wording) => BOOKED_OPTION.test(wording)
    ? 'The recipient\'s booked receiving option, left out of the history: a wish, not a movement.'
    : REFUSED_REDIRECT.test(wording) ? 'A redirect DHL refused, a notice and not a delivery attempt: the parcel keeps the stage it had.'
      : PACKSTATION_ADDRESS.test(wording) ? 'A Packstation as the delivery address, a notice and not a movement: the parcel keeps the stage it had.' : undefined,
};
