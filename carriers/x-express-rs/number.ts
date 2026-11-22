import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError } from '../../core/errors/index.js';

/** Two digits and ten, as the tracker's example prints them around its hyphen. */
export const X_EXPRESS_RS_LAYOUT = /^(\d{2})(\d{10})$/;

/**
 * The number as the tracker needs it, with the hyphen after its first two digits: the tracker
 * does not find the twelve digits alone. Any other input is not a shipment number X Express
 * Serbia issues. Shared by the adapter's requests and the tracking links.
 */
export function xExpressRsRequestNumber(raw: string): string {
  const parts = X_EXPRESS_RS_LAYOUT.exec(typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '');
  if (!parts) throw new InvalidInputError('X Express Serbia', 'X Express Serbia shipment numbers are two digits, a hyphen and ten digits');
  return `${parts[1]}-${parts[2]}`;
}
