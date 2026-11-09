/** Aeropost's Costa Rican shipper reference, as read by its public tracking form. */
export function isAeropostReference(number: string): boolean {
  return /^CR\d{10}$/.test(number);
}
