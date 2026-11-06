import type { CarrierResult } from '../../core/result/index.js';
import { dateDhlRows } from '../gzyl/dhl-rows.js';
import { normalizeHualeiNumber, parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { isJrtDhlGermanRow, isJrtDhlRow, isJrtUpsRow, jrtEnglish, jrtStage } from './status.js';

export const PROVIDER = 'JRT';
export const JRT_ORIGIN = 'http://106.53.64.22:8082';
// Once JRT hands a parcel over, the record's tracking number is the delivering carrier's, as
// DHL's into Europe or FedEx's on the line to Ireland, whose product names FedEx, and JRT's
// own number, which still finds the order, is in no field.
export const JRT: HualeiTenant = {
  carrier: 'jrt', provider: PROVIDER, origin: JRT_ORIGIN, stage: jrtStage, english: jrtEnglish,
  clock: ({ content, location }) => (isJrtUpsRow(content, location) || isJrtDhlRow(content) ? 'wall' : 'platform'),
  ownNumber: /^JRT\d{10}[A-Z]{2}$/, unlabelledPartners: ['dhl'], productPartners: [[/\bFEDEX\b/i, 'fedex']],
};

/** The result with the rows the tracker copies from DHL dated, each keeping its wall clock. */
export const dateJrtDhlRows = (result: CarrierResult): CarrierResult =>
  dateDhlRows(result, { isRow: isJrtDhlRow, isGermanRow: isJrtDhlGermanRow });

export const normalizeJrtNumber = (raw: string): string => normalizeHualeiNumber(raw, PROVIDER);
/** The track interface's reply, or null when it holds no row for the number. */
export function parseJrtTrack(payload: unknown, number: string, readAt?: number): CarrierResult | null {
  const result = parseHualeiTrack(payload, number, JRT, readAt);
  return result && dateJrtDhlRows(result);
}
export const parseJrtPage = (html: string, number: string, readAt?: number): CarrierResult =>
  dateJrtDhlRows(parseHualeiPage(html, number, JRT, readAt));
