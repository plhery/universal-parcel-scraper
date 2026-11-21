import type { HualeiTenant } from '../gzyl/hualei.js';
import { GZYL_ORIGIN, splitGzylRow } from '../gzyl/parser.js';
import { yusudaStage } from './status.js';

export const PROVIDER = 'Yusuda';
/**
 * Yusuda's site sends its tracking form to GZYL's tenant of the Hualei
 * platform, which writes its rows in GZYL's words: the host, the row
 * splitting, the scripted delivery row and the one-batch script are GZYL's.
 */
export const YUSUDA: HualeiTenant = {
  carrier: 'yusuda', provider: PROVIDER, origin: GZYL_ORIGIN, stage: yusudaStage, split: splitGzylRow,
  scriptedDelivery: true, oneBatch: true,
};
