import { ginfoAdapter, ginfoLookupUrl, GinfoTracker } from '../hgd/ginfo.js';
import { KING_DELIVERY, KING_DELIVERY_API } from './parser.js';

export { KING_DELIVERY_API, KING_DELIVERY_SITE } from './parser.js';

/** The record the tracking server gives for one number. */
export function kingDeliveryLookupUrl(number: string): string {
  return ginfoLookupUrl(KING_DELIVERY_API, number);
}

export class KingDeliveryTracker extends GinfoTracker {
  constructor(options: ConstructorParameters<typeof GinfoTracker>[1] = {}) { super(KING_DELIVERY, options); }
}

export const adapter = ginfoAdapter(KING_DELIVERY);
