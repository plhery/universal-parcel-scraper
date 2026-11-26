import type { CarrierResult } from '../../core/result/index.js';
import { dateDhlRows } from '../gzyl/dhl-rows.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { dateWallClocks } from '../gzyl/gofo-rows.js';
import { dateJtMexicoRows, isJtMexicoRow } from '../gzyl/jt-mexico-rows.js';
import { huayaStage, isHuayaDestinationRow, isHuayaDhlGermanRow, isHuayaDhlRow, isHuayaItalianRow, isHuayaUsRow } from './status.js';

export const PROVIDER = 'Huaya Express';
export const HUAYA_ORIGIN = 'http://193.112.176.17:8082';
export const HUAYA: HualeiTenant = {
  carrier: 'huaya-express', provider: PROVIDER, origin: HUAYA_ORIGIN, stage: huayaStage,
  clock: ({ content, location }) => (isHuayaDhlRow(content) || isHuayaUsRow(location) || isJtMexicoRow(content)
    || isHuayaDestinationRow(content, location) || isHuayaItalianRow(content, location) ? 'wall' : 'platform'),
};

// The Italian last mile writes its rows on Italy's clock: each was written at the platform's next 4-hourly
// poll after its Italian time, and read on Beijing's they would come seven hours early.
const ITALY_ZONE = 'Europe/Rome';
/** The result with the Italian last mile's rows on a parcel to Italy dated on Italy's clock. */
const dateItalianRows = (result: CarrierResult): CarrierResult => (result.destination_country !== 'IT' ? result
  : dateWallClocks(result, (event) => (isHuayaItalianRow(event.description ?? '', event.location ?? '') ? { zone: ITALY_ZONE, basis: 'place' } : null)));

/**
 * The result with the rows the tracker copies from DHL dated, each keeping its wall clock, J&T Express Mexico's on
 * J&T's clock in Mexico, and the Italian last mile's on Italy's.
 */
export const dateHuayaPartnerRows = (result: CarrierResult): CarrierResult =>
  dateItalianRows(dateJtMexicoRows(dateDhlRows(result, { isRow: isHuayaDhlRow, isGermanRow: isHuayaDhlGermanRow })));

/** The track interface's reply, or null when it holds no row for the number. */
export function parseHuayaTrack(payload: unknown, number: string, readAt?: number): CarrierResult | null {
  const result = parseHualeiTrack(payload, number, HUAYA, readAt);
  return result && dateHuayaPartnerRows(result);
}
export const parseHuayaPage = (html: string, number: string, readAt?: number): CarrierResult =>
  dateHuayaPartnerRows(parseHualeiPage(html, number, HUAYA, readAt));
