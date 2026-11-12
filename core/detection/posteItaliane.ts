import { CARRIER_DEFINITIONS } from '../catalog/definitions.js';
import { CHECKSUMS } from './checksums.js';
import { ruleFits } from './rules.js';
import { isValidS10TrackingNumber } from './s10.js';

/**
 * Catalog shape and check-digit eligibility; a matching Poste lookup must still establish the
 * shipment. A rule's rawPattern reads `printed`, the number as typed, which defaults to the number.
 */
export function isPosteItalianeTrackingNumber(number: string, printed = number): boolean {
  return CARRIER_DEFINITIONS['poste-italiane'].detectionRules.some(rule => ruleFits(rule, number, printed)
    && (rule.checksum === undefined || CHECKSUMS[rule.checksum](number)));
}

/**
 * A DHL Parcel Connect plate that a partner abroad, such as PPL, hands to Poste Italiane with a
 * link to Poste's tracker. DHL issues it, so no detection rule names Poste for it.
 */
export function isPosteItalianePartnerPlate(number: string): boolean {
  return /^JJD\d{21}$/.test(number);
}

/**
 * The code inside the sixteen-character label of a parcel a sender abroad hands to Poste
 * Italiane: three letters, then one of Poste's thirteen-character parcel codes. Vinted Go and
 * Cainiao follow the parcel under the whole label, which Poste's tracker does not know. It
 * follows the code alone, from the day it takes the parcel.
 */
export function posteItalianeLabelCode(number: string): string | null {
  // Poste Delivery Business's `UW` codes and Crono's `5P` codes, the two seen inside a label.
  const code = /^[A-Z]{3}((?:[138]UW|5P[A-Z0-9])[A-Z0-9]{10})$/.exec(number)?.[1];
  return code && isPosteItalianeTrackingNumber(code) ? code : null;
}

/**
 * The numbers Poste's tracker is asked about: its own, the partner plates it takes over and the
 * S10 numbers of mail from abroad, which it can follow under the sending post's number. Only its
 * own are detected as Poste's.
 */
export function isPosteItalianeLookup(number: string): boolean {
  return isPosteItalianeTrackingNumber(number) || isPosteItalianePartnerPlate(number) || isValidS10TrackingNumber(number);
}
