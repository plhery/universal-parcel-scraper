import { normalizeTrackingNumber } from './normalize.js';

export function isKargoturkReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^\d{12,13}$/.test(normalizeTrackingNumber(raw));
}
