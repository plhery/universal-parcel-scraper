import { transvirtualAdapter, transvirtualLookupUrl, TransvirtualTracker, type TransvirtualOptions } from '../vt-freight-express/transvirtual.js';
import { BLACKHAUL_PORTAL } from './parser.js';

/** The tracker's address for one consignment, as its search box builds it. */
export function blackhaulLookupUrl(number: string): string {
  return transvirtualLookupUrl(BLACKHAUL_PORTAL, number);
}

export class BlackhaulTracker extends TransvirtualTracker {
  constructor(options: TransvirtualOptions = {}) {
    super(BLACKHAUL_PORTAL, options);
  }
}

// No recognition: the tracker's answer for a number it has no consignment for
// is inconclusive, and no public number shows Blackhaul's consignment shape.
export const adapter = transvirtualAdapter(BLACKHAUL_PORTAL);
