import { dsyAdapter, type DsySite } from '../overseaex/dsyexpress.js';
import { statusMap } from './status.js';

export { DsyTracker, dsyLookupUrl, normalizeDsyNumber, parseDsy } from '../overseaex/dsyexpress.js';

/** Passerby A Express on the DsyExpress platform. */
export const SHUNJIE: DsySite = {
  carrier: 'shunjie',
  provider: 'Passerby A Express',
  host: 'www.passerbyaexpress.com',
  statusMap,
};

export const adapter = dsyAdapter(SHUNJIE);
