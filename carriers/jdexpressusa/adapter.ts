import { ginfoAdapter, ginfoLookupUrl, GinfoTracker } from '../hgd/ginfo.js';
import { JDEXPRESSUSA, JDEXPRESSUSA_API } from './parser.js';

export { JDEXPRESSUSA_API, JDEXPRESSUSA_SITE } from './parser.js';

/** The record the tracking server gives for one number. */
export function jdExpressUsaLookupUrl(number: string): string {
  return ginfoLookupUrl(JDEXPRESSUSA_API, number);
}

export class JdExpressUsaTracker extends GinfoTracker {
  constructor(options: ConstructorParameters<typeof GinfoTracker>[1] = {}) { super(JDEXPRESSUSA, options); }
}

export const adapter = ginfoAdapter(JDEXPRESSUSA);
