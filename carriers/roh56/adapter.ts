import { ginfoAdapter, ginfoLookupUrl, GinfoTracker } from '../hgd/ginfo.js';
import { ROH56, ROH56_API } from './parser.js';

export { ROH56_API, ROH56_SITE } from './parser.js';

/** The record the tracking server gives for one number. */
export function roh56LookupUrl(number: string): string {
  return ginfoLookupUrl(ROH56_API, number);
}

export class Roh56Tracker extends GinfoTracker {
  constructor(options: ConstructorParameters<typeof GinfoTracker>[1] = {}) { super(ROH56, options); }
}

export const adapter = ginfoAdapter(ROH56);
