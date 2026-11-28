import type { AdapterFactory } from '../../core/adapter/index.js';
import { LqfastTracker, type LqfastTenant } from '../anjiexin56/lqfast.js';
import { renyuanwuliuStage, statusMap } from './status.js';

/** Renyuan Logistics (任远物流) on Lanqiao's waybill portal, under the company id its site links with. */
export const RENYUANWULIU: LqfastTenant = {
  carrier: 'renyuanwuliu', provider: 'Renyuan Logistics', companyId: 'AKVKpwhKcTmYqx3ELFLB2g==', company: /任远/u,
  stage: renyuanwuliuStage, statusMap,
};

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LqfastTracker(RENYUANWULIU, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: RENYUANWULIU.carrier, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
