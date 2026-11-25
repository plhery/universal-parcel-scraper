import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { kunExpressClock, repeatsKunExpressRow, splitKunExpressRow } from '../kun-express/parser.js';
import { bulongguojiStage } from './status.js';

export const PROVIDER = 'BULONGGUOJI';
export const BULONGGUOJI_ORIGIN = 'http://106.52.54.99:8082';

/**
 * The tracker copies one USPS scan more than once at the same minute and place: alone, with the
 * category USPS files it under ahead ("On the Way, Arrived at USPS Facility") as Kun Express's
 * does, or with USPS's detail after it ("Out for Delivery, Expected Delivery by 9:00pm"). Either
 * longer wording is that scan again.
 */
export const repeatsBulongguojiRow = (wording: string, other: string): boolean =>
  repeatsKunExpressRow(wording, other) || wording.startsWith(`${other}, `);

/**
 * BULONGGUOJI's (布龙国际) tenant of the Hualei platform. Its US line hands the parcel to USPS,
 * whose number the record gives as the channel's transfer number, without a channel name. The
 * tracker copies USPS's scans the way Kun Express's does: after their place, to the minute on the
 * facility's clock, while the line's own rows come to the second on the platform's Beijing clock.
 */
export const BULONGGUOJI: HualeiTenant = {
  carrier: 'bulongguoji', provider: PROVIDER, origin: BULONGGUOJI_ORIGIN, stage: bulongguojiStage,
  split: splitKunExpressRow, clock: kunExpressClock, repeats: repeatsBulongguojiRow, unlabelledPartners: ['usps'],
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseBulongguojiTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, BULONGGUOJI, readAt);
export const parseBulongguojiPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, BULONGGUOJI, readAt);
