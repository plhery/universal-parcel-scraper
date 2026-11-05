import { normalizeTrackingNumber } from './normalize.js';

/** Guest docket eligibility, not ownership of a shared numeric format. */
export function isVXpressReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^(?!0{7}$|0{10}$)(?:\d{7}|\d{10})$/.test(normalizeTrackingNumber(raw));
}
