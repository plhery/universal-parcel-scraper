import { ginfoAdapter, ginfoLookupUrl, GinfoTracker } from '../hgd/ginfo.js';
import { SRJ, SRJ_API } from './parser.js';

export { SRJ_API, SRJ_SITE } from './parser.js';

/** The record the tracking server gives for one number. */
export function srjLookupUrl(number: string): string {
  return ginfoLookupUrl(SRJ_API, number);
}

export class SrjTracker extends GinfoTracker {
  constructor(options: ConstructorParameters<typeof GinfoTracker>[1] = {}) { super(SRJ, options); }
}

export const adapter = ginfoAdapter(SRJ);
