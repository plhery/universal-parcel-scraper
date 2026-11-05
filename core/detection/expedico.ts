import { normalizeTrackingNumber } from './normalize.js';

/** Supported guest references, without assigning partners' barcodes to Expedico. */
export function isExpedicoReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^(?:\d{13}|\d{16}F\d{4})$/.test(normalizeTrackingNumber(raw));
}
