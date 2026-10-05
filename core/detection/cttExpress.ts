/** Spanish shipment references and the sole package's complete label code. */
export function isCttExpressTrackingNumber(number: string): boolean {
  return /^00\d{20}(?:001)?$/.test(number);
}
