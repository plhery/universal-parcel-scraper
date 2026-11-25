import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { sdhExpressStage } from './status.js';

export const PROVIDER = 'Lightning Monkey';
export const SDH_EXPRESS_ORIGIN = 'http://182.254.152.160:8082';

/**
 * Lightning Monkey's (闪电猴, SDH Express) tenant of the Hualei platform. Its US line's rows, the
 * ones in the United States included, come to the second on the platform's Beijing clock and name
 * no delivery carrier.
 */
export const SDH_EXPRESS: HualeiTenant = {
  carrier: 'sdh-express', provider: PROVIDER, origin: SDH_EXPRESS_ORIGIN, stage: sdhExpressStage,
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseSdhExpressTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, SDH_EXPRESS, readAt);
export const parseSdhExpressPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, SDH_EXPRESS, readAt);
