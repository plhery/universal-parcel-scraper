import { ginfoAdapter, ginfoLookupUrl, GinfoTracker } from '../hgd/ginfo.js';
import { YLEXP, YLEXP_API } from './parser.js';

export { YLEXP_API, YLEXP_SITE } from './parser.js';

/** The record the tracking server gives for one number. */
export function ylexpLookupUrl(number: string): string {
  return ginfoLookupUrl(YLEXP_API, number);
}

export class YlexpTracker extends GinfoTracker {
  constructor(options: ConstructorParameters<typeof GinfoTracker>[1] = {}) { super(YLEXP, options); }
}

export const adapter = ginfoAdapter(YLEXP);
