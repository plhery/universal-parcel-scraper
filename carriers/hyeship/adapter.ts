import { ginfoAdapter, ginfoLookupUrl, GinfoTracker } from '../hgd/ginfo.js';
import { HYESHIP, HYESHIP_API } from './parser.js';

export { HYESHIP_API, HYESHIP_SITE } from './parser.js';

/** The record the tracking server gives for one number. */
export function hyeshipLookupUrl(number: string): string {
  return ginfoLookupUrl(HYESHIP_API, number);
}

export class HyeshipTracker extends GinfoTracker {
  constructor(options: ConstructorParameters<typeof GinfoTracker>[1] = {}) { super(HYESHIP, options); }
}

export const adapter = ginfoAdapter(HYESHIP);
