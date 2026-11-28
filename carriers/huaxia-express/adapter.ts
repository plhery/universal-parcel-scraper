import { ginfoAdapter, ginfoLookupUrl, GinfoTracker } from '../hgd/ginfo.js';
import { HUAXIA, HUAXIA_API } from './parser.js';

export { HUAXIA_API, HUAXIA_SITE } from './parser.js';

/** The record the tracking server gives for one number. */
export function huaxiaLookupUrl(number: string): string {
  return ginfoLookupUrl(HUAXIA_API, number);
}

export class HuaxiaTracker extends GinfoTracker {
  constructor(options: ConstructorParameters<typeof GinfoTracker>[1] = {}) { super(HUAXIA, options); }
}

export const adapter = ginfoAdapter(HUAXIA);
