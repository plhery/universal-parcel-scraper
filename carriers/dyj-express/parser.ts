import type { HualeiTenant } from '../gzyl/hualei.js';
import { kunExpressClock } from '../kun-express/parser.js';
import { dyjExpressStage } from './status.js';

export const PROVIDER = 'DYJ Express';
export const DYJ_EXPRESS_ORIGIN = 'http://43.138.180.250:8082';

/**
 * DYJ Express's (深圳达运佳国际物流) tenant of the Hualei platform. Its US line hands the parcel to
 * USPS, whose number the record gives as the channel's transfer number, without a channel name.
 * The tracker copies USPS's scans the way Kun Express's does: to the minute on the facility's
 * clock, while the line's own rows come to the second on the platform's Beijing clock.
 */
export const DYJ_EXPRESS: HualeiTenant = {
  carrier: 'dyj-express', provider: PROVIDER, origin: DYJ_EXPRESS_ORIGIN, stage: dyjExpressStage,
  clock: kunExpressClock, unlabelledPartners: ['usps'],
};
