import type { CarrierResult } from '../../core/result/index.js';
import { dateDhlRows } from '../gzyl/dhl-rows.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiRow, type HualeiTenant } from '../gzyl/hualei.js';
import { isSuocangDhlGermanRow, isSuocangDhlRow, suocangStage } from './status.js';

export const PROVIDER = 'Suoexpress';
export const SUOCANG_ORIGIN = 'http://42.193.237.14:8082';

/**
 * The line's own rows, in China or without a place, are on the platform's Beijing clock. A row
 * copied from DHL, placed or not, keeps its wall clock: it is on DHL's clock where DHL scanned the
 * parcel, and the tracker writes no zone.
 */
export const suocangClock = ({ content }: HualeiRow): 'platform' | 'wall' => (isSuocangDhlRow(content) ? 'wall' : 'platform');

/** Suoexpress's (所仓物流, SUOCANG) tenant of the Hualei platform, whose European line hands parcels to DHL in Germany. */
export const SUOCANG: HualeiTenant = {
  carrier: 'suocang', provider: PROVIDER, origin: SUOCANG_ORIGIN, stage: suocangStage, clock: suocangClock,
};

/** The result with the rows the tracker copies from DHL dated, each keeping its wall clock. */
export const dateSuocangDhlRows = (result: CarrierResult): CarrierResult =>
  dateDhlRows(result, { isRow: isSuocangDhlRow, isGermanRow: isSuocangDhlGermanRow });

/** The track interface's reply, or null when it holds no row for the number. */
export function parseSuocangTrack(payload: unknown, number: string, readAt?: number): CarrierResult | null {
  const result = parseHualeiTrack(payload, number, SUOCANG, readAt);
  return result && dateSuocangDhlRows(result);
}

export const parseSuocangPage = (html: string, number: string, readAt?: number): CarrierResult =>
  dateSuocangDhlRows(parseHualeiPage(html, number, SUOCANG, readAt));
