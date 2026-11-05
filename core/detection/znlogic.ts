import { normalizeTrackingNumber } from './normalize.js';

/** Zinc's marketplace references; retailer and delivering-carrier numbers are separate. */
export function isZnlogicReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^ZPY[A-Z]{2}\d{10}YQ$/.test(normalizeTrackingNumber(raw));
}
