import { normalizeTrackingNumber } from './normalize.js';

/** Post One's own item series; a partner's reference does not establish issuer ownership. */
export function isPostOneReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^R\d{10}$/.test(normalizeTrackingNumber(raw));
}
