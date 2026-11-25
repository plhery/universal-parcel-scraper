import type { CarrierResult } from '../../core/result/index.js';
import { dateHualeiDhlRows, hualeiDhlClock } from '../gzyl/dhl-rows.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { suocangStage } from './status.js';

export const PROVIDER = 'Suoexpress';
export const SUOCANG_ORIGIN = 'http://42.193.237.14:8082';

/**
 * Suoexpress's (所仓物流, SUOCANG) tenant of the Hualei platform, whose European line hands parcels
 * to DHL in Germany. Its own rows are on the platform's Beijing clock and DHL's keep their wall clock.
 */
export const SUOCANG: HualeiTenant = {
  carrier: 'suocang', provider: PROVIDER, origin: SUOCANG_ORIGIN, stage: suocangStage, clock: hualeiDhlClock,
};

/** The track interface's reply, or null when it holds no row for the number. */
export function parseSuocangTrack(payload: unknown, number: string, readAt?: number): CarrierResult | null {
  const result = parseHualeiTrack(payload, number, SUOCANG, readAt);
  return result && dateHualeiDhlRows(result);
}

export const parseSuocangPage = (html: string, number: string, readAt?: number): CarrierResult =>
  dateHualeiDhlRows(parseHualeiPage(html, number, SUOCANG, readAt));
