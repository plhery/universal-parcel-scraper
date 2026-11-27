import { glsNationalAdapter, type GLSNationalNetwork } from '../gls-hu/national.js';

// GLS Czech Republic's national parcel numbers exist only under the tracking service's Czech path, as GLS
// Hungary's do under the Hungarian one: the same overview, read the same way.
export const CZECH_REPUBLIC: GLSNationalNetwork = {
  id: 'gls-cz',
  provider: 'GLS Czech Republic',
  country: 'CZ',
  timezone: 'Europe/Prague',
  page: 'https://gls-group.com/CZ/cs/sledovani-zasilek/',
};

export const adapter = glsNationalAdapter(CZECH_REPUBLIC);
