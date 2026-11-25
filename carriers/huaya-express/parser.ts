import type { CarrierResult } from '../../core/result/index.js';
import { dateDhlRows } from '../gzyl/dhl-rows.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { dateJtMexicoRows, isJtMexicoRow } from '../gzyl/jt-mexico-rows.js';
import { huayaStage, isHuayaDestinationRow, isHuayaDhlGermanRow, isHuayaDhlRow, isHuayaUsRow } from './status.js';

export const PROVIDER = 'Huaya Express';
export const HUAYA_ORIGIN = 'http://193.112.176.17:8082';
export const HUAYA: HualeiTenant = {
  carrier: 'huaya-express', provider: PROVIDER, origin: HUAYA_ORIGIN, stage: huayaStage,
  clock: ({ content, location }) => (isHuayaDhlRow(content) || isHuayaUsRow(location) || isJtMexicoRow(content)
    || isHuayaDestinationRow(content, location) ? 'wall' : 'platform'),
};

/** The result with the rows the tracker copies from DHL dated, each keeping its wall clock, and J&T Express Mexico's on J&T's clock in Mexico. */
export const dateHuayaPartnerRows = (result: CarrierResult): CarrierResult =>
  dateJtMexicoRows(dateDhlRows(result, { isRow: isHuayaDhlRow, isGermanRow: isHuayaDhlGermanRow }));

/** The track interface's reply, or null when it holds no row for the number. */
export function parseHuayaTrack(payload: unknown, number: string, readAt?: number): CarrierResult | null {
  const result = parseHualeiTrack(payload, number, HUAYA, readAt);
  return result && dateHuayaPartnerRows(result);
}
export const parseHuayaPage = (html: string, number: string, readAt?: number): CarrierResult =>
  dateHuayaPartnerRows(parseHualeiPage(html, number, HUAYA, readAt));
