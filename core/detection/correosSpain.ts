/**
 * A Correos expedition code: the product letters, label code and nine digits
 * its parcel code starts with, closed by its own check letter. Parcel codes
 * carry seven more digits before theirs.
 */
export function isCorreosSpainExpeditionCode(number: string): boolean {
  return /^[PD][A-Z][A-Z0-9]{4}\d{9}[A-Z]$/.test(number);
}
