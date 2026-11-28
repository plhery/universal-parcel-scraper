import { flowlinkAdapter, type FlowLinkSite } from './flowlink.js';
import { statusMap } from './status.js';

export { FlowLinkTracker, flowlinkText, normalizeFlowLinkNumber, parseFlowLink } from './flowlink.js';

/**
 * JDX Express on Changyunda's FlowLink system: tenant `jdxexpress`, its tracking page, and Hong Kong's clock,
 * which mainland China shares, for every row.
 */
export const JDX_EXPRESS: FlowLinkSite = {
  carrier: 'jdxexpress',
  provider: 'JDX Express',
  tenant: 'jdxexpress',
  page: 'http://www.jdxexpress.com/select.html',
  zone: 'Asia/Hong_Kong',
  zoneBasis: 'carrier',
  statusMap,
};

export const adapter = flowlinkAdapter(JDX_EXPRESS);
