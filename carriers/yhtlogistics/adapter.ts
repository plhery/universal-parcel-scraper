import { ginfoAdapter, ginfoLookupUrl, GinfoTracker } from '../hgd/ginfo.js';
import { YHT, YHT_API } from './parser.js';

export { YHT_API, YHT_SITE } from './parser.js';

/** The record the tracking server gives for one number. */
export function yhtLookupUrl(number: string): string {
  return ginfoLookupUrl(YHT_API, number);
}

export class YhtTracker extends GinfoTracker {
  constructor(options: ConstructorParameters<typeof GinfoTracker>[1] = {}) { super(YHT, options); }
}

export const adapter = ginfoAdapter(YHT);
