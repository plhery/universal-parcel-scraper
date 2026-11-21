import { InterparcelTracker, interparcelAdapter, interparcelTrackingUrl, type InterparcelSite } from './interparcel.js';

export const PROVIDER = 'Interparcel UK';
export const INTERPARCEL_UK: InterparcelSite = { carrier: 'interparcel-uk', provider: PROVIDER, origin: 'https://uk.interparcel.com', prefix: 'GB' };

/** The tracking page of one Interparcel UK reference. */
export const interparcelUkUrl = (raw: string): string => interparcelTrackingUrl(INTERPARCEL_UK, raw);

export class InterparcelUkTracker extends InterparcelTracker {
  constructor(options: ConstructorParameters<typeof InterparcelTracker>[1] = {}) { super(INTERPARCEL_UK, options); }
}

export const adapter = interparcelAdapter(INTERPARCEL_UK);
