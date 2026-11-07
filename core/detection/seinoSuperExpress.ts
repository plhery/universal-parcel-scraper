import { normalizeTrackingNumber } from './normalize.js';

/** The SSX guest form accepts its whole slip, not Seino Transportation's separate identifier. */
export function isSeinoSuperExpressReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^(?:\d{10}|\d{13}|\d{15})$/.test(normalizeTrackingNumber(raw));
}
