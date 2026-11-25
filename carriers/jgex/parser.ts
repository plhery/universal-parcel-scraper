import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { kunExpressClock, repeatsKunExpressRow, splitKunExpressRow } from '../kun-express/parser.js';
import { jgexEnglish, jgexStage } from './status.js';

export const PROVIDER = 'JGEX';
export const JGEX_ORIGIN = 'http://www.jgex.net:8082';

/**
 * JGEX's tenant of the Hualei platform. Its US line copies USPS's scans the way Kun Express's
 * does: after their place, to the minute on the facility's clock, while the forwarder's own rows
 * come to the second on the platform's Beijing clock. The rows are read as Kun Express reads them.
 */
export const JGEX: HualeiTenant = {
  carrier: 'jgex', provider: PROVIDER, origin: JGEX_ORIGIN, stage: jgexStage, english: jgexEnglish,
  split: splitKunExpressRow, clock: kunExpressClock, repeats: repeatsKunExpressRow,
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseJgexTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, JGEX, readAt);
export const parseJgexPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, JGEX, readAt);
