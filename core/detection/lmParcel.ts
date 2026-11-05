import { normalizeTrackingNumber } from './normalize.js';

/** LM's own references, without borrowing the delivering carrier's barcode. */
export function isLmParcelReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^LM\d{10}$/.test(normalizeTrackingNumber(raw));
}
