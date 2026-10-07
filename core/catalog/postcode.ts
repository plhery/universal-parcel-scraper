/** Any country's postcode: 3 to 12 characters with a digit, in groups joined by one space or hyphen. */
export const DELIVERY_POSTCODE = /^(?=.{3,12}$)(?=.*\d)[A-Z0-9]+(?:[ -][A-Z0-9]+)*$/;

/** A typed postcode as it is checked and sent: trimmed, in capitals, with single spaces. */
export function deliveryPostcodeText(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, ' ');
}
