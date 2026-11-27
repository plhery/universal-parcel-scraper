import type { AdapterFactory } from '../../core/adapter/index.js';
import { LqfastTracker, type LqfastTenant } from './lqfast.js';
import { anjiexinStage, statusMap } from './status.js';

/** ANJIEXIN Logistics (安捷信物流) on Lanqiao's waybill portal, under the company id its query page carries. */
export const ANJIEXIN: LqfastTenant = {
  carrier: 'anjiexin56', provider: 'ANJIEXIN Logistics', companyId: 'JNCqnZaL7Kz+bo2dhhXzyQ==', stage: anjiexinStage, statusMap,
};

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LqfastTracker(ANJIEXIN, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: ANJIEXIN.carrier, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
