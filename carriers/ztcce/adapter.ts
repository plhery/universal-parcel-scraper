import { kdfeiAdapter, type KdfeiSite } from './kdfei.js';
import { statusMap } from './status.js';

export { KdfeiTracker, kdfeiText, normalizeKdfeiNumber, parseKdfei } from './kdfei.js';

/** ZTCCE on the kdfei platform: tenant `ao`, its waybill page, and the warehouses its waybills start from. */
export const ZTCCE: KdfeiSite = {
  carrier: 'ztcce',
  provider: 'ZTCCE',
  tenant: 'ao',
  page: 'https://www.ztcce.com/waybill.html',
  warehouses: {
    Austin: 'America/Chicago', 奥斯汀: 'America/Chicago',
    'Las Vegas': 'America/Los_Angeles', 拉斯维加斯: 'America/Los_Angeles',
    'Los Angeles': 'America/Los_Angeles', 洛杉矶: 'America/Los_Angeles', Walnut: 'America/Los_Angeles',
  },
  statusMap,
};

export const adapter = kdfeiAdapter(ZTCCE);
