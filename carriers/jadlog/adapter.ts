import type { AdapterFactory } from '../../core/adapter/index.js';
import { DPDTracker } from '../dpd/adapter.js';

/** Jadlog reads the Geopost guest protocol of the myJadlog app, under Jadlog's own business-unit selector. */
export const adapter: AdapterFactory = (environment) => {
  const tracker = new DPDTracker({
    country: 'BR',
    fetcher: environment.fetcher,
    recorder: environment.recorder,
    userAgent: environment.userAgent,
  });
  return {
    id: 'jadlog', recordsSteps: true, steps: ['direct'],
    // The catalog asks for no postcode, so Geopost answers without verifying the recipient.
    track: (input, context) => tracker.fetch(input.number, '', context),
    // The guest API's current country: Brazil.
    recognize: async (number, context) => ({ known: await tracker.recognizes(number, context) }),
  };
};
