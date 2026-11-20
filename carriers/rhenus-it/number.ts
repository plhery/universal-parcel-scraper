import { InvalidInputError } from '../../core/errors/index.js';

export const PROVIDER = 'Rhenus Italia';

// A home-delivery number without its printed hyphen: nine digits and a two-digit suffix.
export const RHENUS_IT_HOME_LAYOUT = /^(\d{9})(\d{2})$/;

/** A shipment number as the tracking page asks for it. */
export function normalizeNumber(raw: string): string {
  const number = raw.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Enter a Rhenus Italia shipment number');
  // The home-delivery lookup requires the printed separator, which the shared input drops.
  return number.replace(RHENUS_IT_HOME_LAYOUT, '$1-$2');
}
