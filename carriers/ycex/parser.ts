import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { dateSuocangDhlRows, suocangClock } from '../suocang/parser.js';
import { ycexEnglish, ycexStage } from './status.js';

export const PROVIDER = 'YCEX';
export const YCEX_ORIGIN = 'http://159.75.78.252:8082';

/**
 * YCEX's (永财国际物流) tenant of the Hualei platform. Its European line flies into Amsterdam and
 * hands parcels to DHL, whose rows the tracker copies on DHL's wall clock, as Suoexpress's does,
 * without DHL's number; its own rows are on the platform's Beijing clock.
 */
export const YCEX: HualeiTenant = {
  carrier: 'ycex', provider: PROVIDER, origin: YCEX_ORIGIN, stage: ycexStage, english: ycexEnglish, clock: suocangClock,
};

/** The track interface's reply, or null when it holds no row for the number. */
export function parseYcexTrack(payload: unknown, number: string, readAt?: number): CarrierResult | null {
  const result = parseHualeiTrack(payload, number, YCEX, readAt);
  return result && dateSuocangDhlRows(result);
}

export const parseYcexPage = (html: string, number: string, readAt?: number): CarrierResult =>
  dateSuocangDhlRows(parseHualeiPage(html, number, YCEX, readAt));
