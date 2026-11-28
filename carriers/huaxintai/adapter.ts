import type { AdapterFactory } from '../../core/adapter/index.js';
import { KepponTracker, type KepponTenant } from './keppon.js';
import { huaxintaiStage, statusMap } from './status.js';

/** Huaxintai Logistics (华鑫泰物流) on its Keppon tracking page, under the tenant id its listing links with. */
export const HUAXINTAI: KepponTenant = {
  carrier: 'huaxintai', provider: 'Huaxintai Logistics', page: 'http://se.keppon.cn:8057/OnlineTrack.aspx', cid: '3356',
  stage: huaxintaiStage, statusMap,
};

/**
 * No recognition: the firm's waybills are a dense counter of five and six digits, so a waybill
 * under a number says little about whether the parcel asked about is the firm's.
 */
export const adapter: AdapterFactory = (environment) => {
  const tracker = new KepponTracker(HUAXINTAI, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: HUAXINTAI.carrier, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
