import type { HualeiTenant } from '../gzyl/hualei.js';
import { sxwStage } from './status.js';

export const PROVIDER = 'SXW Express';
export const SXW_ORIGIN = 'http://www.sxwexpress.cn:8082';
/**
 * SXW Express's own tenant of the Hualei platform. Its waybills open with SXW; the
 * tracking number a record holds beside one is the delivery carrier's, GOFO's in
 * the United States, which the tracker names no channel for.
 */
export const SXW: HualeiTenant = {
  carrier: 'sxw-express', provider: PROVIDER, origin: SXW_ORIGIN, stage: sxwStage,
  ownNumber: /^SXW\d{12}$/, unlabelledPartners: ['gofo'],
};
