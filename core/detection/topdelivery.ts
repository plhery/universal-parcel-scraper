import { normalizeTrackingNumber } from './normalize.js';

export function isTopdeliveryReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^\d{6,8}$/.test(normalizeTrackingNumber(raw));
}
