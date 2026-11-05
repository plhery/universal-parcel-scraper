import { normalizeTrackingNumber } from './normalize.js';

/** References supported by this carrier's public guest route, without establishing ownership. */
export function isFxdcPostReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^(?!0{8}$)\d{8}$/.test(normalizeTrackingNumber(raw));
}
