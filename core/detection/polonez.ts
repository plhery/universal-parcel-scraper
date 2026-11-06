import { normalizeTrackingNumber } from './normalize.js';

/** Current Polonez labels documented by its own tracker, not arbitrary Meest references. */
export function isPolonezReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^(?:PIE|POL)\d{3}MP\d{6}$/.test(normalizeTrackingNumber(raw));
}
