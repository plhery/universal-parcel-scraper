/** The domestic waybill format used by J&T Brazil's public guest form. */
export function isJAndTBrReference(raw: string): boolean {
  return typeof raw === 'string' && /^888\d{12}$/.test(raw.trim());
}
