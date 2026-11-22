import { isHualeiUsPartnerRow } from '../gzyl/gofo-rows.js';
import type { HualeiRow, HualeiTenant } from '../gzyl/hualei.js';
import { fsqhEnglish, fsqhStage } from './status.js';

export const PROVIDER = 'FSQH';
export const FSQH_ORIGIN = 'http://www.fsqh.hailei2018.com:8082';

const CHINESE = /[一-鿿]/;

/**
 * A row's clock. The line's rows in China, placed in Chinese, at "CN" or without a place, or worded
 * in Chinese, are on the platform's Beijing clock. The rows it copies from the line abroad, an
 * airport, warehouse or hub named in English, keep that place's wall clock, and so does GOFO's label.
 */
function fsqhClock({ content, location }: HualeiRow): 'platform' | 'wall' {
  if (isHualeiUsPartnerRow(content, location)) return 'wall';
  const place = location.trim();
  return !place || place.toUpperCase() === 'CN' || CHINESE.test(place) || CHINESE.test(content) ? 'platform' : 'wall';
}

/**
 * FSQH's own tenant of the Hualei platform. A record holds the delivery carrier's number in its
 * transfer field without a channel: GOFO's on the line to the United States, Royal Mail's on the
 * line to Britain, each claimed whole by its own rule.
 */
export const FSQH: HualeiTenant = {
  carrier: 'fsqh', provider: PROVIDER, origin: FSQH_ORIGIN, stage: fsqhStage, english: fsqhEnglish,
  ownNumber: /^QH\d{12}FS$/, unlabelledPartners: ['gofo', 'royal-mail'], clock: fsqhClock,
};
