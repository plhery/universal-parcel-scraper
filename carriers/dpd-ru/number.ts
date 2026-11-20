import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError } from '../../core/errors/index.js';

/**
 * The order numbers of DPD's network in Russia, Belarus and Kazakhstan, as its
 * integration guide writes them: the country's letters and nine digits, eleven
 * digits, or eight digits and a terminal's three letters.
 */
export const DPD_RU_LAYOUT = /^(?:(?:RU|BY|KZ)\d{9}|\d{11}|\d{8}[A-Z]{3})$/;

/** The number as the tracker takes it: upper case, without spaces or dashes. */
export function dpdRuRequestNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!DPD_RU_LAYOUT.test(number)) throw new InvalidInputError('DPD Russia', 'DPD Russia numbers are RU, BY or KZ and nine digits, or eleven digits');
  return number;
}
