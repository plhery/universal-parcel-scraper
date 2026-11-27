import { VT_FREIGHT_EXPRESS_PORTAL } from './parser.js';
import { transvirtualAdapter, transvirtualLookupUrl, TransvirtualTracker, type TransvirtualOptions } from './transvirtual.js';

export { normalizeVtFreightExpressNumber, parseVtFreightExpress } from './parser.js';

/** VT Freight Express's public tracker on its consignment software. */
export const VT_FREIGHT_EXPRESS_TRACKER = VT_FREIGHT_EXPRESS_PORTAL.tracker;

/** The tracker's address for one consignment, as its search box builds it. */
export function vtFreightExpressLookupUrl(number: string): string {
  return transvirtualLookupUrl(VT_FREIGHT_EXPRESS_PORTAL, number);
}

export class VtFreightExpressTracker extends TransvirtualTracker {
  constructor(options: TransvirtualOptions = {}) {
    super(VT_FREIGHT_EXPRESS_PORTAL, options);
  }
}

// No recognition: the tracker's answer for a number it has no consignment for
// is inconclusive, and the sender prefixes name senders, so no rule offers it.
export const adapter = transvirtualAdapter(VT_FREIGHT_EXPRESS_PORTAL);
