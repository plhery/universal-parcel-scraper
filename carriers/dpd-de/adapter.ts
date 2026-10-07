import type { AdapterFactory } from '../../core/adapter/index.js';
import { CarrierError, carrierErrorKind } from '../../core/errors/index.js';
import { recoverableByDefault } from '../../core/runner/index.js';
import { DPDTracker } from '../dpd/adapter.js';
import { DPD_DE_OTHER_COUNTRY, DpdDeAppClient } from './app.js';

/** Germany uses the same guest protocol, with its own business-unit selector, then the German app's service. */
export const adapter: AdapterFactory = (environment) => {
  const app = new DpdDeAppClient({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  const tracker = new DPDTracker({
    country: 'DE',
    fetcher: environment.fetcher,
    firebaseApiKey: environment.env.DPD_FIREBASE_API_KEY,
    recorder: environment.recorder,
    userAgent: environment.userAgent,
    app: {
      run: (number, context) => app.track(number, context),
      // The app reads the same parcel, so it cannot place another country's delivery in Germany.
      recovers: error => (recoverableByDefault(error) || carrierErrorKind(error) === 'schema')
        && !(error instanceof CarrierError && error.reason === DPD_DE_OTHER_COUNTRY),
    },
  });
  return {
    id: 'dpd-de', recordsSteps: true, steps: ['direct', 'app'],
    track: (input, context) => tracker.fetch(input.number, input.postcode ?? '', context),
  };
};
