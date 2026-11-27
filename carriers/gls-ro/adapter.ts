import { glsNationalAdapter, type GLSNationalNetwork } from '../gls-hu/national.js';

// GLS Romania's national parcel numbers exist only under the tracking service's Romanian path, as GLS
// Hungary's do under the Hungarian one: the same overview, read the same way.
export const ROMANIA: GLSNationalNetwork = {
  id: 'gls-ro',
  provider: 'GLS Romania',
  country: 'RO',
  timezone: 'Europe/Bucharest',
  page: 'https://gls-group.com/RO/ro/urmarire-colet/',
};

export const adapter = glsNationalAdapter(ROMANIA);
