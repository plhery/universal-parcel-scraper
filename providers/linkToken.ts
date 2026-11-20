import { amazonShareToken } from '../core/catalog/urls.js';
import { CARRIER_CATALOG, type CarrierId } from '../generated/catalog.js';

/**
 * Whether a carrier's number is the token of the link that opens the parcel (`tracking.linkToken`),
 * as an Amazon order's: it means nothing to a provider, so none is asked about it.
 */
export function numberIsLinkToken(carrier: string | null | undefined): boolean {
  return !!carrier && Object.hasOwn(CARRIER_CATALOG, carrier)
    && CARRIER_CATALOG[carrier as CarrierId].tracking.linkToken === true;
}

/**
 * Whether a number is kept from every provider as a link's token: its carrier's number is one
 * (`numberIsLinkToken`), or no catalog carrier is named and it has the shape of an Amazon share
 * link's token, a UUID with a letter among its hex digits, which opens the shared order page.
 * The token reaches a caller as the number of the link `parseTrackingInput` reads, and an
 * integration may pass that number on alone. A FedEx Ground 96 barcode, thirty-two digits, has no letter.
 */
export function linkTokenKept(carrier: string | null | undefined, number: string | undefined): boolean {
  if (numberIsLinkToken(carrier)) return true;
  const named = !!carrier && carrier !== 'unknown' && Object.hasOwn(CARRIER_CATALOG, carrier);
  return !named && !!number && /[a-f]/i.test(number) && amazonShareToken(number) !== undefined;
}
