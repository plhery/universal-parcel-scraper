import { isValidS10TrackingNumber } from './s10.js';

/** The international guest lookup, without claiming the issuing post's numbers. */
export function isJunfengInternationalReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && isValidS10TrackingNumber(raw);
}
