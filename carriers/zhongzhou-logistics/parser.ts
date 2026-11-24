import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { isZhongzhouNotice, repeatsZhongzhouRow, zhongzhouEnglish, zhongzhouStage } from './status.js';

export const PROVIDER = 'Zhongzhou Logistics';
/** The tracker the site's tracking page frames over HTTPS, on its plain-HTTP port. */
export const ZHONGZHOU_ORIGIN = 'http://zhongzhouwuliu.com:8082';

/**
 * Zhongzhou Logistics' own tenant of the Hualei platform. A record keeps Zhongzhou's number, `ZZ`,
 * ten digits and `CN`, as its tracking number. The track interface also finds the record by GOFO
 * France's number for the parcel, which it returns in no field, so that number is GOFO France's
 * hand-off. Rows abroad come on clocks the record does not state, so every row keeps its wall clock.
 */
export const ZHONGZHOU_LOGISTICS: HualeiTenant = {
  carrier: 'zhongzhou-logistics', provider: PROVIDER, origin: ZHONGZHOU_ORIGIN, stage: zhongzhouStage,
  english: zhongzhouEnglish, repeats: repeatsZhongzhouRow, notice: isZhongzhouNotice, wallClocks: true,
  ownNumber: /^ZZ\d{10}CN$/, unlabelledPartners: ['gofo-fr'], partnerNumbers: true,
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseZhongzhouTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, ZHONGZHOU_LOGISTICS, readAt);

export const parseZhongzhouPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, ZHONGZHOU_LOGISTICS, readAt);
