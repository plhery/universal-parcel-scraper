/**
 * A Yunda Express domestic waybill: 13 or 15 digits. Yunda's own client routes
 * 76/77 international identifiers to its international website instead of the
 * domestic feed.
 */
export function isYundaDomesticWaybill(value: string): boolean {
  return /^\d{13}(?:\d{2})?$/.test(value) && !/^(?:76|77)/.test(value);
}
