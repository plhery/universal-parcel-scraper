import type { HualeiTenant } from '../gzyl/hualei.js';
import { jchEnglish, jchStage } from './status.js';

export const PROVIDER = 'JCH';
export const JCH_ORIGIN = 'http://www.jch-exp.com:8082';

// The line's rows in China carry no place or its "Transit Center"; the platform writes them on Beijing's clock.
const ORIGIN_PLACE = /^(?:,\s*)?(?:transit center)?$/i;

/**
 * JCH's own tenant of the Hualei platform. Rows placed at an airport or a town abroad keep their
 * place's wall clock: a flight leaving at a Beijing clock lands at Incheon on Seoul's and in
 * Toronto on Toronto's. The tracking number a record holds beside a JCH waybill is the delivery
 * carrier's, SpeedX's in the United States, which the tracker names no channel for.
 */
export const JCH: HualeiTenant = {
  carrier: 'jch', provider: PROVIDER, origin: JCH_ORIGIN, stage: jchStage, english: jchEnglish,
  ownNumber: /^JCHSG\d{13}$/, unlabelledPartners: ['speedx'],
  clock: ({ location }) => (ORIGIN_PLACE.test(location.trim()) ? 'platform' : 'wall'),
};
