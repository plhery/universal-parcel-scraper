import type { AdapterFactory } from '../../core/adapter/index.js';
import { DPDTracker } from '../dpd/adapter.js';

/** Germany uses the same guest protocol, with its own business-unit selector. */
export const adapter: AdapterFactory = (environment) => {
  const tracker = new DPDTracker({
    country: 'DE',
    fetcher: environment.fetcher,
    firebaseApiKey: environment.env.DPD_FIREBASE_API_KEY,
    recorder: environment.recorder,
    userAgent: environment.userAgent,
  });
  return {
    id: 'dpd-de', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, input.postcode ?? '', context),
  };
};
