import type { AdapterFactory } from '../../core/adapter/index.js';
import { LqfastTracker, type LqfastTenant } from '../anjiexin56/lqfast.js';
import { annengyuntongStage, statusMap } from './status.js';

/** Annengyuntong Logistics (安能运通物流) on Lanqiao's waybill portal, under the company id its site links with. */
export const ANNENGYUNTONG: LqfastTenant = {
  carrier: 'annengyuntong', provider: 'Annengyuntong Logistics', companyId: '9d3suZLQaTTCLeYx7PsD8w==', stage: annengyuntongStage, statusMap,
};

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LqfastTracker(ANNENGYUNTONG, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: ANNENGYUNTONG.carrier, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
