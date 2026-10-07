import type { AdapterFactory } from '../../core/adapter/index.js';
import { CarrierError, carrierErrorKind } from '../../core/errors/index.js';
import { DPDTracker } from '../dpd/adapter.js';
import { DPD_DE_OTHER_COUNTRY, DpdDeAppClient } from './app.js';

/** Left to the guest API when the app's session is still opening ahead of it. */
const GUEST_RESERVE_MS = 20_000;

/** Germany reads the German app's service, then the guest protocol with its own business-unit selector. */
export const adapter: AdapterFactory = (environment) => {
  const app = new DpdDeAppClient({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  const tracker = new DPDTracker({
    country: 'DE',
    fetcher: environment.fetcher,
    firebaseApiKey: environment.env.DPD_FIREBASE_API_KEY,
    recorder: environment.recorder,
    userAgent: environment.userAgent,
    app: {
      run: (number, { signal, timeoutMs, leads }) => app.track(number, {
        signal, timeoutMs, sessionWaitMs: leads ? Math.max(0, timeoutMs - GUEST_RESERVE_MS) : timeoutMs,
      }),
      // Each service has its own host, limits and outages, so either answers when
      // the other fails. Both read the same parcel: neither can place another
      // country's delivery in Germany, nor find a parcel the guest API does not know.
      recovers: error => carrierErrorKind(error) !== 'not_found'
        && !(error instanceof CarrierError && error.reason === DPD_DE_OTHER_COUNTRY),
    },
  });
  return {
    id: 'dpd-de', recordsSteps: true, steps: ['app', 'direct'],
    track: (input, context) => tracker.fetch(input.number, input.postcode ?? '', context),
  };
};
