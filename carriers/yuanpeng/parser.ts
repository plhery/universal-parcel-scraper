import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { kunExpressClock, repeatsKunExpressRow, splitKunExpressRow } from '../kun-express/parser.js';
import { yuanpengStage } from './status.js';

export const PROVIDER = 'Yuanpeng';
export const YUANPENG_ORIGIN = 'http://www.yuanpeng56.com:8082';

// The row in which the forwarder names the USPS number the parcel goes on under.
const HAND_OFF = /^Last Mile Tracking Number ([A-Z0-9]{6,40})$/i;

/**
 * Yuanpeng's US line copies USPS's scans the way Kun Express's does: after their place, with
 * USPS's explanation after an arrow, and more than once. Its own rows come to the second on the
 * platform's Beijing clock, USPS's to the minute on the facility's, so the rows are read as Kun
 * Express reads them.
 */
export const YUANPENG: HualeiTenant = {
  carrier: 'yuanpeng', provider: PROVIDER, origin: YUANPENG_ORIGIN, stage: yuanpengStage,
  split: splitKunExpressRow, clock: kunExpressClock, repeats: repeatsKunExpressRow,
  handOff: (content) => HAND_OFF.exec(content)?.[1], unlabelledPartners: ['usps'],
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseYuanpengTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, YUANPENG, readAt);
export const parseYuanpengPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, YUANPENG, readAt);
