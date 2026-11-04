import { normalizeTrackingNumber } from './normalize.js';
import { isValidS10TrackingNumber } from './s10.js';

/** References the guest tracker accepts; this does not assign postal numbers to Flickpost. */
export function isFlickpostReference(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length > 64) return false;
  const number = normalizeTrackingNumber(raw);
  return /^X\d{6}$/.test(number) || (number.endsWith('MY') && isValidS10TrackingNumber(number));
}
