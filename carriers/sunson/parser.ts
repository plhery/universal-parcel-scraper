import type { HualeiTenant } from '../gzyl/hualei.js';
import { sunsonEnglish, sunsonStage } from './status.js';

export const PROVIDER = 'Sunson Logistics';
export const SUNSON_ORIGIN = 'http://111.230.206.59:8082';

/**
 * Sunson's (深圳燊鑫国际物流) tenant of the Hualei platform. Its rows are written in China, on the
 * platform's Beijing clock: the line's warehouses in Shenzhen and Guangzhou, and the order's data.
 */
export const SUNSON: HualeiTenant = {
  carrier: 'sunson', provider: PROVIDER, origin: SUNSON_ORIGIN, stage: sunsonStage, english: sunsonEnglish,
};
