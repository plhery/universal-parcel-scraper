import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError } from '../../core/errors/index.js';

/**
 * Navex's tracking numbers are digits. Its tracker's own example is twelve of
 * them; the adapter takes a few more or fewer, since one example is no rule.
 */
export const NAVEX_LAYOUT = /^\d{8,20}$/;

/** The number as Navex's tracker takes it: its digits alone. */
export function navexRequestNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NAVEX_LAYOUT.test(number)) throw new InvalidInputError('Navex Delivery', 'Navex numbers are digits');
  return number;
}
