import { normalizeTrackingNumber } from './normalize.js';

/** References supported by this carrier's public guest route, without establishing ownership. */
export function isFreightwaysGlobalReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^(?:NZC\d{9}|GSS\d{6,20}|\d{1,12}NZC\d{9})$/.test(normalizeTrackingNumber(raw));
}
