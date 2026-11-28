import { flowlinkAdapter, type FlowLinkPlace, type FlowLinkSite } from '../jdxexpress/flowlink.js';
import { statusMap } from './status.js';

export { FlowLinkTracker, normalizeFlowLinkNumber, parseFlowLink } from '../jdxexpress/flowlink.js';

const HOME = 'America/Los_Angeles';
const CHINA = 'Asia/Shanghai';
// The firm's own name in the brackets, over the rows of its Los Angeles warehouse.
const FIRM = /^美西(?:环球)?速运$/u;
// A route, "美国-中国": the flight's departure, which the US side writes.
const ROUTE = /^\S+?[-－—]\S+$/u;
const US = /^美国|洛杉矶/u;
// The system's codes for the import into China, the courier there and the signature.
const CHINA_LEG = /^(?:GIN_|GLT_|G_SIGN$)/u;

/**
 * A row's place and clock. The brackets name the firm, a route or a place in the United States over the US
 * side's rows, which the firm writes from Los Angeles, or a place in China over the rows from the parcel's
 * arrival there. A row without brackets is on the firm's clock, unless its code is one of China's leg.
 */
export function meixiPlace(bracketed: string, code: string): FlowLinkPlace {
  if (!bracketed) return { location: '', zone: CHINA_LEG.test(code) ? { zone: CHINA, basis: 'destination' } : null };
  if (FIRM.test(bracketed) || ROUTE.test(bracketed)) return { location: '', zone: null };
  if (US.test(bracketed)) return { location: bracketed, zone: /洛杉矶/u.test(bracketed) ? { zone: HOME, basis: 'place' } : null };
  return { location: bracketed, zone: { zone: CHINA, basis: 'place' } };
}

/**
 * Meixi Express on Changyunda's FlowLink system: tenant `j5ex`, its tracking page, Los Angeles' clock for the
 * firm's rows and China's for those in China.
 */
export const MEIXI: FlowLinkSite = {
  carrier: 'meixi',
  provider: 'Meixi Express',
  tenant: 'j5ex',
  page: 'https://www.j5ex.com/select.html',
  zone: HOME,
  zoneBasis: 'carrier',
  statusMap,
  place: meixiPlace,
};

export const adapter = flowlinkAdapter(MEIXI);
