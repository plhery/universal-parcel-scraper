import type { AdapterFactory } from '../../core/adapter/index.js';
import { statusMap, eudoreStage } from './status.js';
import { T6Tracker, type T6Tenant } from './t6.js';

/** Eudore's line, the `tbwl` tenant (腾博物流) of the T6 platform. */
export const EUDORE: T6Tenant = {
  carrier: 'eudore', provider: 'Eudore', origin: 'https://tbwl.t6soft.com', stage: eudoreStage, statusMap,
};

export const adapter: AdapterFactory = (environment) => {
  const tracker = new T6Tracker(EUDORE, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: EUDORE.carrier, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
