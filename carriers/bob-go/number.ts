import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError } from '../../core/errors/index.js';

/**
 * Bob Go's tracking references: capitals and digits. The one public
 * reference reads `UA` and six more; the adapter takes any short run, as
 * Bob Go's tracker does.
 */
export const BOB_GO_LAYOUT = /^[A-Z0-9]{6,30}$/;

/** The reference as Bob Go's tracker sends it: in capitals, without spaces or hyphens. */
export function bobGoRequestNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!BOB_GO_LAYOUT.test(number)) throw new InvalidInputError('Bob Go', 'Bob Go references are letters and digits');
  return number;
}
