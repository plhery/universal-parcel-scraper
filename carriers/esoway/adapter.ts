import { ginfoAdapter, ginfoLookupUrl, GinfoTracker } from '../hgd/ginfo.js';
import { ESOWAY, ESOWAY_API } from './parser.js';

export { ESOWAY_API, ESOWAY_SITE } from './parser.js';

/** The record the tracking server gives for one number. */
export function esowayLookupUrl(number: string): string {
  return ginfoLookupUrl(ESOWAY_API, number);
}

export class EsowayTracker extends GinfoTracker {
  constructor(options: ConstructorParameters<typeof GinfoTracker>[1] = {}) { super(ESOWAY, options); }
}

export const adapter = ginfoAdapter(ESOWAY);
