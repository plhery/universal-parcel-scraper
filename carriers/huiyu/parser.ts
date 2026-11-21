import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { huiyuEnglish, huiyuStage } from './status.js';

export const PROVIDER = 'Huiyu International';
export const HUIYU_ORIGIN = 'http://81.71.24.16:8082';

/**
 * Huiyu International's own tenant of the Hualei platform, which its site links by address. A
 * record keeps the delivery carrier's number in its tracking number, with no channel named: Royal
 * Mail's on the line to the United Kingdom, which Royal Mail's own rule claims whole.
 */
export const HUIYU: HualeiTenant = {
  carrier: 'huiyu', provider: PROVIDER, origin: HUIYU_ORIGIN, stage: huiyuStage, english: huiyuEnglish,
  ownNumber: /^HY\d{13}YQ$/, unlabelledPartners: ['royal-mail'],
};

export const parseHuiyuTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null => parseHualeiTrack(payload, number, HUIYU, readAt);

export const parseHuiyuPage = (html: string, number: string, readAt?: number): CarrierResult => parseHualeiPage(html, number, HUIYU, readAt);
