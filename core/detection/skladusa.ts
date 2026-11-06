import { normalizeTrackingNumber } from './normalize.js';

/** The system reference printed on SkladUSA's own shipping labels. */
export function isSkladusaReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^SK\d{10}UA$/.test(normalizeTrackingNumber(raw));
}
