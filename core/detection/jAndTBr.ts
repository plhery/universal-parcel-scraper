/** The fifteen-digit domestic waybills, 888 and 99988, that J&T Brazil's public guest form answers. */
export function isJAndTBrReference(raw: string): boolean {
  return typeof raw === 'string' && /^(?:888\d{12}|99988\d{10})$/.test(raw.trim());
}
