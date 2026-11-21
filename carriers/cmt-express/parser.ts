import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { cmtExpressEnglish, cmtExpressStage } from './status.js';

export const PROVIDER = 'CMT Express';
// The tracker's HTTPS host; port 8082 of the same host serves the same tracker over plain HTTP.
export const CMT_EXPRESS_ORIGIN = 'https://tms.cmtexpress.com.cn';

// The warehouse rows give Shenzhen as "SZ.", which as a code is Eswatini's: no place.
const SHENZHEN = /^\s*SZ\.?\s*$/i;

/** A row's place without the warehouse's short name for Shenzhen. */
export function splitCmtExpressRow(content: string, location: string): { content: string; location: string } {
  return { content, location: SHENZHEN.test(location) ? '' : location };
}

/**
 * CMT Express's own tenant of the Hualei platform, which its site's waybill query posts to. A
 * tracking number of another shape than its own is the delivery carrier's, as on the platform's
 * other tenants; no record names that carrier yet.
 */
export const CMT_EXPRESS: HualeiTenant = {
  carrier: 'cmt-express', provider: PROVIDER, origin: CMT_EXPRESS_ORIGIN, stage: cmtExpressStage, english: cmtExpressEnglish,
  split: splitCmtExpressRow, ownNumber: /^CMT\d{12}$/,
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseCmtExpressTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, CMT_EXPRESS, readAt);

export const parseCmtExpressPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, CMT_EXPRESS, readAt);
