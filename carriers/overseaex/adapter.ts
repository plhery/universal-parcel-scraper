import { dsyAdapter, type DsySite } from './dsyexpress.js';
import { statusMap } from './status.js';

export { DsyTracker, dsyLookupUrl, dsyText, normalizeDsyNumber, parseDsy } from './dsyexpress.js';

/** Oversea Express on the DsyExpress platform. */
export const OVERSEAEX: DsySite = {
  carrier: 'overseaex',
  provider: 'Oversea Express',
  host: 'www.overseaex.com',
  statusMap,
};

export const adapter = dsyAdapter(OVERSEAEX);
