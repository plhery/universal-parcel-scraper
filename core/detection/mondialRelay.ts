/**
 * Mondial Relay label barcode checksum.
 *
 * What it is: the 26-digit label check used by the `"mondial-relay"` detection
 * rule and by input validation.
 * What it is not: no carrier lookup and no provider I/O. The caller passes an
 * already-normalized number; anything else fails the digits-only shape test.
 */
import { mod11CheckDigit } from './numericChecksums.js';

/**
 * The barcode's head without its key: brand(2), shipment(8), sequence(2),
 * count(2). Its parcel sequence runs from one to the count. It has no check
 * digit, so this filters the shape and proves nothing about the carrier.
 */
export function isMondialRelayBarcodeHead(value: string): boolean {
  if (!/^\d{14}$/.test(value)) return false;
  const sequence = Number(value.slice(10, 12));
  return sequence > 0 && sequence <= Number(value.slice(12, 14));
}

/** Mondial Relay label specification v2.4, pages 5–7 (July 2024).
 * https://storage.mondialrelay.fr/etiquette-mondial-relay-v-24.pdf
 * Brand(2), shipment(8), sequence(2), count(2), check(1), routing(10), check(1).
 */
export function isValidMondialRelayBarcode(value: string): boolean {
  if (!/^\d{26}$/.test(value)) return false;
  const check = (digits: string) => String(mod11CheckDigit(digits));
  return isMondialRelayBarcodeHead(value.slice(0, 14))
    && check(value.slice(0, 14)) === value[14] && check(value.slice(15, 25)) === value[25];
}
