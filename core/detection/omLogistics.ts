/** Numeric dockets accepted by Om's guest form; this does not claim their issuer. */
export function isOmLogisticsReference(number: string): boolean {
  return /^\d{8,13}$/.test(number);
}
