import { normalizeTrackingNumber } from './normalize.js';

export function isRoyaleInternationalReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^\d{12}$/.test(normalizeTrackingNumber(raw));
}
