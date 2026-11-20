import type { AdapterFactory } from '../../core/adapter/index.js';
import { FreightAeroTracker, type FreightAeroAirline } from './freightAero.js';

export { FREIGHT_AERO_LOOKUP, freightAeroPageUrl, freightAeroWaybill, FreightAeroTracker, parseFreightAero } from './freightAero.js';

/** Biman Bangladesh Airlines' cargo, BG, whose waybills start with 997. */
export const BIMAN: FreightAeroAirline = { provider: 'biman-bangladesh', name: 'Biman', code: 'BG', prefix: '997' };

export const adapter: AdapterFactory = environment => {
  const tracker = new FreightAeroTracker(environment, BIMAN);
  return { id: BIMAN.provider, steps: ['trawl'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context) };
};
