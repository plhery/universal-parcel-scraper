import { InvalidInputError } from '../../core/errors/index.js';

export const PROVIDER = 'Sway';

// The two forms the tracker finds only as printed, once the shared input has dropped the hyphen or capitalised the id.
export const SWAY_RESTORED_LAYOUT = /^(?:SWY\d{9}|C[A-Z0-9]{19})$/;

/** A Sway tracking number as the tracker asks for it. */
export function normalizeNumber(raw: string): string {
  const number = raw.trim();
  if (!/^[A-Z0-9][A-Z0-9-]{5,39}$/i.test(number)) throw new InvalidInputError(PROVIDER, 'Enter a Sway tracking number');
  // The public form shows SWY- plus nine digits. The older Swyft id is case-sensitive.
  const branded = /^SWY-?(\d{9})$/i.exec(number);
  if (branded) return `SWY-${branded[1]}`;
  if (/^C[A-Z0-9]{19}$/i.test(number)) return number.toLowerCase();
  return number;
}
