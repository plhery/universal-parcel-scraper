import type { CarrierResult } from '../../core/result/index.js';
import { normalizeHualeiNumber, parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { isJrtUpsRow, jrtEnglish, jrtStage } from './status.js';

export const PROVIDER = 'JRT';
export const JRT_ORIGIN = 'http://106.53.64.22:8082';
// Once JRT hands a parcel over, the record's tracking number is the delivering carrier's, as
// DHL's into Europe or FedEx's on the line to Ireland, whose product names FedEx, and JRT's
// own number, which still finds the order, is in no field.
export const JRT: HualeiTenant = {
  carrier: 'jrt', provider: PROVIDER, origin: JRT_ORIGIN, stage: jrtStage, english: jrtEnglish,
  clock: ({ content, location }) => (isJrtUpsRow(content, location) ? 'wall' : 'platform'),
  ownNumber: /^JRT\d{10}[A-Z]{2}$/, unlabelledPartners: ['dhl'], productPartners: [[/\bFEDEX\b/i, 'fedex']],
};

export const normalizeJrtNumber = (raw: string): string => normalizeHualeiNumber(raw, PROVIDER);
/** The track interface's reply, or null when it holds no row for the number. */
export const parseJrtTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, JRT, readAt);
export const parseJrtPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, JRT, readAt);
