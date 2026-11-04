import { calendarDay } from '../time/index.js';
import { normalizeTrackingNumber } from './normalize.js';

/** A supported guest reference, not evidence that Fez owns the shipment. */
export function isFezDeliveryReference(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length > 64) return false;
  const match = /^[A-Z0-9]{4}(\d{2})(\d{2})(\d{2})\d{2}$/.exec(normalizeTrackingNumber(raw));
  return !!match && !!calendarDay(2000 + Number(match[3]), Number(match[2]), Number(match[1]));
}
