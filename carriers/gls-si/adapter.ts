import { glsNationalAdapter, type GLSNationalNetwork } from '../gls-hu/national.js';

// GLS Slovenia's national parcel numbers exist only under the tracking service's Slovenian path, as GLS
// Hungary's do under the Hungarian one: the same overview, read the same way.
export const SLOVENIA: GLSNationalNetwork = {
  id: 'gls-si',
  provider: 'GLS Slovenia',
  country: 'SI',
  timezone: 'Europe/Ljubljana',
  page: 'https://gls-group.com/SI/sl/sledenje-posiljki/',
};

export const adapter = glsNationalAdapter(SLOVENIA);
