import type { AdapterFactory } from '../../core/adapter/index.js';
import { LqfastTracker, type LqfastTenant } from '../anjiexin56/lqfast.js';
import { mengxiangtongStage, statusMap } from './status.js';

/** Mengxiangtong Logistics (盟翔通物流) on Lanqiao's waybill portal, under the company id its site links with. */
export const MENGXIANGTONG: LqfastTenant = {
  carrier: 'mengxiangtong', provider: 'Mengxiangtong Logistics', companyId: 'shU7Eab0eKhHUXNJPh/oYg==', company: /盟翔通/u,
  stage: mengxiangtongStage, statusMap,
};

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LqfastTracker(MENGXIANGTONG, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: MENGXIANGTONG.carrier, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
