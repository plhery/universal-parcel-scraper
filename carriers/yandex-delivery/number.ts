import { InvalidInputError } from '../../core/errors/index.js';

const PROVIDER = 'Yandex Delivery';

/** The layout the tracking page gives, LO- and nine digits, as a stored number keeps it: without its hyphen. */
export const YANDEX_DELIVERY_LAYOUT = /^LO\d{9}$/;

/**
 * A tracking or order number as the page's form takes it: 6 to 40 Latin letters, digits and
 * hyphens, in capitals. The tracker finds an LO number only with the hyphen after LO and answers
 * it without one as not found, so a number stored without it (normalized numbers drop hyphens)
 * gets it back. Shared by the adapter's requests and the tracking links.
 */
export function yandexDeliveryRequestNumber(raw: string): string {
  const number = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!/^[A-Z0-9-]{6,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Yandex Delivery numbers are 6 to 40 Latin letters, digits and hyphens');
  return YANDEX_DELIVERY_LAYOUT.test(number) ? `LO-${number.slice(2)}` : number;
}
