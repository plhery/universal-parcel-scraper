import type { HualeiRow, HualeiTenant } from '../gzyl/hualei.js';
import { lingxunStage } from './status.js';

export const PROVIDER = 'LingXun Logistics';
export const LINGXUN_ORIGIN = 'http://129.204.198.136:8082';

const CHINESE = /\p{Script=Han}/u;

/**
 * A row's clock. The line's own rows, with a kind code, without a place, placed in Chinese or at
 * "CN", or worded in Chinese, are on the platform's Beijing clock. The rows it copies from the
 * delivery network abroad, placed at a town named in English, keep that town's wall clock.
 */
export function lingxunClock({ code, content, location }: HualeiRow): 'platform' | 'wall' {
  const place = location.trim();
  return code || !place || place.toUpperCase() === 'CN' || CHINESE.test(place) || CHINESE.test(content) ? 'platform' : 'wall';
}

/**
 * LingXun's (深圳市领讯物流) tenant of the Hualei platform. Its lines abroad end with a delivery
 * network whose scans the tracker copies into the record under LingXun's own number.
 */
export const LINGXUN: HualeiTenant = {
  carrier: 'lingxun-logistics', provider: PROVIDER, origin: LINGXUN_ORIGIN, stage: lingxunStage, clock: lingxunClock,
};
