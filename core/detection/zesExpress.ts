/** ZES's printed forwarding waybill; a matching shape alone is not shipment evidence. */
export function isZesExpressReference(number: string): boolean {
  return /^ZESZE\d{10}YQ$/.test(number);
}
