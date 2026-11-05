import { normalizeTrackingNumber } from './normalize.js';

/** Own EWS references; partners' barcodes remain with their issuers. */
export function isProfitFieldsReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^EWS[A-Z]{2}(?:\d{10}|\d{12})YQ$/.test(normalizeTrackingNumber(raw));
}
