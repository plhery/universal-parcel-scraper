import type { HualeiRow, HualeiTenant } from '../gzyl/hualei.js';
import { isJytwlFlightForecast, jytwlEnglish, jytwlStage } from './status.js';

export const PROVIDER = 'JYTWL';
export const JYTWL_ORIGIN = 'http://118.195.157.162:8082';

const CHINESE = /\p{Script=Han}/u;

/**
 * A row's clock. The line's own rows, with a kind code, placed in Chinese or nowhere, or worded in
 * Chinese, are on the platform's Beijing clock. The rows it copies from abroad, worded in English
 * or Finnish at a place written in Latin letters, keep that place's wall clock: the exchange
 * office's and the Dutch customs rows, the arrival notice at Amsterdam and Posti's scans.
 */
export function jytwlClock({ code, content, location }: HualeiRow): 'platform' | 'wall' {
  const place = location.trim();
  return code || !place || CHINESE.test(place) || CHINESE.test(content) ? 'platform' : 'wall';
}

/**
 * JYTWL's (广州玖运通国际物流服务有限公司) tenant of the Hualei platform. Its line to Finland flies
 * the parcel to Amsterdam, clears it there and hands it to Posti, whose scans it copies without
 * Posti's number. GBK cannot hold Finnish ä and ö, which arrive as question marks and stay so.
 */
export const JYTWL: HualeiTenant = {
  carrier: 'jytwl', provider: PROVIDER, origin: JYTWL_ORIGIN, stage: jytwlStage, english: jytwlEnglish,
  clock: jytwlClock, notice: (_code, wording) => isJytwlFlightForecast(wording), lostLetters: true,
};
