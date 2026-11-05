import { normalizeTrackingNumber } from './normalize.js';

/** FAN's guest lookup accepts its AWB, not every partner barcode identifying that parcel. */
export function isFanCourierReference(raw: string): boolean {
  return typeof raw === 'string' && /^\d{13}$/.test(normalizeTrackingNumber(raw));
}
