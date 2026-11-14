import { normalizeTrackingNumber } from './normalize.js';

/**
 * FAN Courier International's shipment numbers: sixteen digits, an F and four
 * digits, the number its tracker echoes as the shipment's request number. Its
 * tracker also answers for its own internal number and the FAN Courier AWB of
 * the Romanian leg, which belong to other shapes.
 */
export function isFanCourierInternationalNumber(raw: string): boolean {
  return typeof raw === 'string' && /^\d{16}F\d{4}$/.test(normalizeTrackingNumber(raw));
}
