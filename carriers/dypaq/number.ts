import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError } from '../../core/errors/index.js';

/**
 * DYPAQ's guías: letters and digits. Its API documentation shows two letters
 * and nine digits; the adapter takes any short run of capitals and digits,
 * since its tracker also takes other references.
 */
export const DYPAQ_LAYOUT = /^[A-Z0-9]{8,20}$/;

/** The guía as DYPAQ's tracker takes it: in capitals, without spaces or hyphens. */
export function dypaqRequestNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!DYPAQ_LAYOUT.test(number) || !/\d/.test(number)) throw new InvalidInputError('DYPAQ', 'DYPAQ guías are letters and digits');
  return number;
}
