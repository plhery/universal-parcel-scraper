import { normalizeTrackingNumber } from './normalize.js';

/** Only the complete numeric reference verified on X-Cargo's group tracker. */
export function isXcargoReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^\d{16}$/.test(normalizeTrackingNumber(raw));
}
