import { dsyAdapter, type DsySite } from '../overseaex/dsyexpress.js';
import { statusMap } from './status.js';

export { DsyTracker, dsyLookupUrl, normalizeDsyNumber, parseDsy } from '../overseaex/dsyexpress.js';

/** SD Group on the DsyExpress platform, with the zone of the place its line-haul rows name in the US. */
export const USASD: DsySite = {
  carrier: 'usasd',
  provider: 'SD Group',
  host: 'www.usasd.com',
  statusMap,
  places: { '美国 - 纽约': 'America/New_York' },
};

export const adapter = dsyAdapter(USASD);
