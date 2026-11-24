import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiTenant } from '../gzyl/hualei.js';
import { shengaoEnglish, shengaoStage } from './status.js';

export const PROVIDER = 'SHENGAO';
export const SHENGAO_ORIGIN = 'http://www.shengaoguojiwuliu.com:8082';

/**
 * SHENGAO's own tenant of the Hualei platform. Its rows, the line's and the
 * last-mile partner's it copies included, are read on the platform's Beijing clock.
 */
export const SHENGAO: HualeiTenant = {
  carrier: 'shengao', provider: PROVIDER, origin: SHENGAO_ORIGIN, stage: shengaoStage, english: shengaoEnglish,
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseShengaoTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, SHENGAO, readAt);
export const parseShengaoPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, SHENGAO, readAt);
