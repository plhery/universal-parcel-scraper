import { glsNationalAdapter, type GLSNationalNetwork } from '../gls-hu/national.js';

// GLS Slovakia's national parcel numbers exist only under the tracking service's Slovak path, as GLS
// Hungary's do under the Hungarian one: the same overview, read the same way.
export const SLOVAKIA: GLSNationalNetwork = {
  id: 'gls-sk',
  provider: 'GLS Slovakia',
  country: 'SK',
  timezone: 'Europe/Bratislava',
  page: 'https://gls-group.com/SK/sk/sledovanie-zasielok/',
};

export const adapter = glsNationalAdapter(SLOVAKIA);
