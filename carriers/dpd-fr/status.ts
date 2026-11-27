/**
 * DPD France status vocabulary.
 *
 * The recipient trace page carries no status codes at all: every row is French
 * prose in a `<td>`, so the only key available is the wording itself. Matching
 * is done on a diacritic- and punctuation-free form of the sentence
 * (`comparableText`) because DPD France varies accents, apostrophes and
 * trailing punctuation between rows.
 *
 * Order matters: returns and incidents are checked before the delivery
 * wording, because "votre colis sera retourné à l'expéditeur" contains neither
 * a delivery verb nor an incident noun on its own.
 *
 * Provenance: wording observed on https://trace.dpd.fr/fr/trace/<number> for
 * outbound and return legs, and the shorter "Colis …" rows of earlier trace
 * pages kept by the Internet Archive.
 */
import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { clean } from '../../core/transport/text.js';

/**
 * Lowercase, accent-free, punctuation-free form used for every wording
 * comparison. A spacing accent typed for an apostrophe ("l´expéditeur")
 * separates words like the apostrophe would.
 */
export function comparableText(value: string): string {
  return clean(value)
    .toLocaleLowerCase('fr-FR')
    .normalize('NFD')
    .replace(/[^\p{Ll}\p{Lu}\p{Lt}\p{Lo}\p{Number}\p{Mark}]+/gu, ' ')
    .replace(/\p{Mark}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function includesAny(value: string, phrases: string[]): boolean {
  return phrases.some((phrase) => value.includes(phrase));
}

/** The notice that the recipient was told of the acceptance, by its `comparableText` form. */
export function isAcceptanceNotice(value: string): boolean {
  return value.includes('de la prise en charge de son colis');
}

/** The notice that the recipient was told of the delivery's current step, by its `comparableText` form. */
function isStepNotice(value: string): boolean {
  return value.includes('de l etape actuelle de sa livraison');
}

/** The notice that the recipient was told the parcel is on its way, by its `comparableText` form. */
function isShipmentNotice(value: string): boolean {
  return value.includes('de l expedition de son colis');
}

/** The notice that the recipient was asked to book the delivery again, by its `comparableText` form. */
function isRebookNotice(value: string): boolean {
  return value.includes('de la necessite de reprogrammer sa livraison');
}

/** The notice that the recipient was told the delivery is put off, by its `comparableText` form. */
function isPostponementNotice(value: string): boolean {
  return value.includes('du report de sa livraison');
}

/**
 * The notice of the delivery's planned day, by its `comparableText` form: "La livraison de votre colis est programmée
 * <day>", where DPD can leave its template's "Date" in place of the day.
 */
function isScheduleNotice(value: string): boolean {
  return value.includes('la livraison de votre colis est programmee');
}

/** The recipient's booking of a new day, by its `comparableText` form. */
export function isRebooking(value: string): boolean {
  return value.includes('a programme une nouvelle livraison');
}

/**
 * A notice to the recipient that names no step of its own: of the acceptance, of the parcel on its way (which can
 * come during the round), of the delivery's current step, that the delivery is put off, which comes during the round
 * before its own scan, that the delivery must be booked again, which follows the scan of the round that did not
 * deliver, or of the delivery's planned day.
 */
export function isRecipientNotice(value: string): boolean {
  return isAcceptanceNotice(value) || isShipmentNotice(value) || isStepNotice(value) || isRebookNotice(value)
    || isPostponementNotice(value) || isScheduleNotice(value);
}

export function classifyStatus(description: string): ClassifiedStatus {
  const value = comparableText(description);

  if (includesAny(value, [
    'retour a l expediteur',
    'retourne a l expediteur',
    'sera retourne a l expediteur',
    'colis en retour',
  ])) return { status: 'exception', stage: 'returned' };

  if (includesAny(value, [
    'reclamation',
    'enquete est ouverte',
    'incident',
    'anomalie',
    'endommage',
    'refuse',
    'perdu',
    'en attente de vos instructions',
    // "L'adresse de livraison nécessite un complément d'informations de la part de l'expéditeur": the parcel waits
    // until the sender completes the address.
    'necessite un complement d information',
  ])) return { status: 'exception', stage: 'exception' };

  // "Votre livraison risque d'être reportée d'un jour ouvré à cause d'un retard d'acheminement": a delay on the way,
  // announced before any round. No delivery was tried, so the "retard" of a failed round below does not read it.
  if (value.includes('retard d acheminement')) return { status: 'in_transit', stage: 'in_transit' };

  if (includesAny(value, [
    'echec de livraison',
    'livraison impossible',
    'n a pas pu etre livre',
    'tentative de livraison',
    // "Votre livraison n'a pas pu être réalisée ce jour, elle est reprogrammée au prochain jour ouvré", hours after
    // the round's scan: the round did not deliver.
    'n a pas pu etre realisee',
    // "Nous n'avons pas pu livrer votre colis", just before that row: the same round that did not deliver.
    'pas pu livrer',
    // "Le destinataire était absent lors du passage de notre livreur, nous avons déposé votre colis en point Pickup":
    // the round did not deliver, and the Pickup point's own row follows.
    'etait absent lors du passage',
    'retard',
    'prise de rendez vous necessaire',
  ])) return { status: 'exception', stage: 'failed_attempt' };

  if (includesAny(value, [
    'votre colis est livre',
    'votre colis a ete livre',
    'remis au destinataire',
    'livraison effectuee',
    'colis livre',
  ])) return { status: 'delivered', stage: 'delivered' };

  if (includesAny(value, [
    'disponible en relais',
    'disponible au relais',
    'disponible en agence',
    'disponible au retrait dans votre agence dpd',
    'disponible en consigne',
    'attend en relais',
    'disponible au point relais',
    'a disposition',
    // The recipient told by SMS that the parcel waits in the Pickup point, or not told because the SMS or e-mail
    // failed: either way it waits there. One of them spells it "disponibilté".
    'de la disponibilite de son colis',
    'de la disponibilte de son colis',
    // "Le destinataire est relancé par SMS (or par e-mail) quant à la disponibilité de son colis dans le relais Pickup":
    // a reminder, days later, that it still waits there.
    'quant a la disponibilite de son colis',
  ])) return { status: 'out_for_delivery', stage: 'ready_for_pickup' };

  // The same-day notices ("le destinataire est informé par SMS de la livraison
  // de son colis ce jour") follow the delivery-round scan; read as plain
  // movement they would pull the parcel back to "in transit" on delivery day.
  if (includesAny(value, [
    'en cours de livraison',
    'en tournee de livraison',
    'chauffeur a pris en charge',
    'de la livraison de son colis ce jour',
    'colis en livraison',
  ])) return { status: 'out_for_delivery', stage: 'out_for_delivery' };

  if (includesAny(value, [
    'en preparation chez l expediteur',
    'informations concernant votre colis ont ete transmises',
    'donnees du colis transmises',
  ])) return { status: 'pending', stage: 'registered' };

  // The notice telling the recipient of the acceptance can come hours later, after a sort
  // centre's scan; staged, it would pull the parcel back to accepted. The acceptance's own scan
  // stages it, and the adapter gives the notice the stage of the scan before it. So it does the notice of the
  // delivery's current step, which DPD sends during the round and names no step.
  if (isRecipientNotice(value)) return { status: 'unknown', stage: 'in_transit' };

  // Acceptance into the network, and the driver's collection from the sender, scanned at the same instant beside it.
  if (includesAny(value, ['pris en charge dans notre reseau', 'pris en charge par notre livreur'])) return { status: 'in_transit', stage: 'accepted' };

  if (includesAny(value, [
    'remis a dpd',
    'pris en charge par dpd',
    'en transit',
    'arrive en france',
    'arrive dans notre agence',
    'prochaine agence',
    'centre de tri',
    'en cours d acheminement',
    'colis en agence',
    // The recipient booked a later day: the parcel waits in the network. The booking names the day, which the
    // adapter reads as the expected delivery.
    'suite a une prise de rendez vous',
    'a programme une nouvelle livraison',
    // "Les instructions de livraison ont bien été prises en compte. L'adresse de livraison a été complétée ou
    // modifiée": the address was put right, and the parcel waits in the network for its next round.
    'adresse de livraison a ete completee ou modifiee',
  ])) return { status: 'in_transit', stage: 'in_transit' };

  // Wording this map does not recognize keeps the row visible without claiming
  // a milestone: the result status stays `unknown` so the lookup falls back to
  // the newest recognized row. The `in_transit` stage kept here predates the
  // package's "omit the stage when it is not mapped" rule; the adapter drops it.
  return { status: 'unknown', stage: 'in_transit' };
}

/**
 * What the map says about one scan. The trace page has no codes, so the
 * wording is the whole key, and wording the map does not recognize gets no
 * stage, as in the adapter.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const classified = code ? null : classifyStatus(wording);
    return classified && classified.status !== 'unknown' ? classified.stage : undefined;
  },
  gaps: [],
  gapNote: (code, wording) => {
    if (code) return undefined;
    const value = comparableText(wording);
    if (isAcceptanceNotice(value)) return 'The recipient told of the acceptance, which can come after the parcel moved on: it keeps the stage it had.';
    if (isShipmentNotice(value)) return 'The recipient told the parcel is on its way, which can come during the round: it keeps the stage it had.';
    if (isRebookNotice(value)) return 'The recipient asked to book the delivery again, after the round that did not deliver: it keeps the stage it had.';
    if (isPostponementNotice(value)) return 'The recipient told the delivery is put off, during the round whose own scan follows: it keeps the stage it had.';
    if (isScheduleNotice(value)) return "The recipient told of the delivery's planned day, at the delivering agency: it keeps the stage it had.";
    return isStepNotice(value) ? "The recipient told of the delivery's current step, during the round: it keeps the stage it had." : undefined;
  },
};
