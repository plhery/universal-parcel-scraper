import { normalizeTrackingNumber } from './normalize.js';

/** Guest-route eligibility, without claiming ownership of the shared numeric shape. */
export function isAirspeedReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^(?!0{9}$)\d{9}$/.test(normalizeTrackingNumber(raw));
}
