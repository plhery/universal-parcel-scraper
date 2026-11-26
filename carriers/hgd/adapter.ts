import { ginfoAdapter, ginfoLookupUrl, GinfoTracker } from './ginfo.js';
import { HGD, HGD_API } from './parser.js';

export { HGD_API, HGD_SITE } from './parser.js';

/** The record the tracking server gives for one number. */
export function hgdLookupUrl(number: string): string {
  return ginfoLookupUrl(HGD_API, number);
}

export class HgdTracker extends GinfoTracker {
  constructor(options: ConstructorParameters<typeof GinfoTracker>[1] = {}) { super(HGD, options); }
}

export const adapter = ginfoAdapter(HGD);
