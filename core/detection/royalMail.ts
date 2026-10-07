/** Domestic references printed below Royal Mail's 2D barcodes. */
export function isRoyalMailDomesticReference(number: string): boolean {
  return /^(?:32\d{11}[A-F0-9]{8}|(?=[A-F0-9]*[A-F])(?=[A-F0-9]*\d)[A-F0-9]{16})$/.test(number);
}
