import { ginfoAdapter, ginfoLookupUrl, GinfoTracker } from '../hgd/ginfo.js';
import { XHONGDA56, XHONGDA56_API } from './parser.js';

export { XHONGDA56_API, XHONGDA56_SITE } from './parser.js';

/** The record the tracking server gives for one number. */
export function xhongda56LookupUrl(number: string): string {
  return ginfoLookupUrl(XHONGDA56_API, number);
}

export class Xhongda56Tracker extends GinfoTracker {
  constructor(options: ConstructorParameters<typeof GinfoTracker>[1] = {}) { super(XHONGDA56, options); }
}

export const adapter = ginfoAdapter(XHONGDA56);
