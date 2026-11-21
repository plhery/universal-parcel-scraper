import { InterparcelTracker, interparcelAdapter, interparcelTrackingUrl, type InterparcelSite } from '../interparcel-uk/interparcel.js';

export const PROVIDER = 'Interparcel Australia';
// Interparcel's page on its Australian site, which holds the references it issued there.
export const INTERPARCEL_AU: InterparcelSite = { carrier: 'interparcel-au', provider: PROVIDER, origin: 'https://au.interparcel.com', prefix: 'AU' };

/** The tracking page of one Interparcel Australia reference. */
export const interparcelAuUrl = (raw: string): string => interparcelTrackingUrl(INTERPARCEL_AU, raw);

export class InterparcelAuTracker extends InterparcelTracker {
  constructor(options: ConstructorParameters<typeof InterparcelTracker>[1] = {}) { super(INTERPARCEL_AU, options); }
}

export const adapter = interparcelAdapter(INTERPARCEL_AU);
