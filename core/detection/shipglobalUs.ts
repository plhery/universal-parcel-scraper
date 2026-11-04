import { normalizeTrackingNumber } from './normalize.js';

export function isShipglobalUsReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^FFUSA\d{6,7}$/.test(normalizeTrackingNumber(raw));
}
