import { normalizeTrackingNumber } from './normalize.js';

/** Costco Logistics' own series, distinct from retail order and work-order numbers. */
export function isCostcoLogisticsReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64
    && /^1I20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{9}$/.test(normalizeTrackingNumber(raw));
}
