import { normalizeTrackingNumber } from './normalize.js';

/** References supported by this carrier's public guest route, without establishing ownership. */
export function isFrontierCaReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^[1-9]\d{7}$/.test(normalizeTrackingNumber(raw));
}
