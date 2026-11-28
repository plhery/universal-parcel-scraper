import type { AdapterFactory } from '../../core/adapter/index.js';
import { LqfastTracker, type LqfastTenant } from '../anjiexin56/lqfast.js';
import { kqtwlStage, statusMap } from './status.js';

/** Kaiqitong Logistics (凯骐通物流) on Lanqiao's waybill portal, under the company id its site links with. */
export const KQTWL: LqfastTenant = {
  carrier: 'kqtwl', provider: 'Kaiqitong Logistics', companyId: '99HDajcB62Q8ilC47SAc0Q==', company: /凯骐通/u,
  stage: kqtwlStage, statusMap,
};

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LqfastTracker(KQTWL, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: KQTWL.carrier, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
