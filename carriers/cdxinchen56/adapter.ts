import type { AdapterFactory } from '../../core/adapter/index.js';
import { LqfastTracker, type LqfastTenant } from '../anjiexin56/lqfast.js';
import { statusMap, xinchenStage } from './status.js';

/** Xinchen Logistics (成都鑫宸物流) on Lanqiao's waybill portal, under the company id its site links with. */
export const XINCHEN: LqfastTenant = {
  carrier: 'cdxinchen56', provider: 'Xinchen Logistics', companyId: '6n09opswzrylt7MBDbTGSg==', stage: xinchenStage, statusMap,
};

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LqfastTracker(XINCHEN, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: XINCHEN.carrier, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
