import { normalizeTrackingNumber } from './normalize.js';

/** The series confirmed by the carrier's public guest tracker. */
export function isCityAirExpressReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^MN\d{6}$/.test(normalizeTrackingNumber(raw));
}
