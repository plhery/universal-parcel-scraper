import type { CarrierResult } from '../../core/result/index.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiRow, type HualeiTenant } from '../gzyl/hualei.js';
import { sdkExpressEnglish, sdkExpressStage } from './status.js';

export const PROVIDER = 'SDK Express';
export const SDK_EXPRESS_ORIGIN = 'http://8.129.105.101:8082';

/**
 * The Russian courier's rows the tracker copies give their day alone, at midnight; the platform's
 * own rows come to the second on its Beijing clock.
 */
export const sdkExpressClock = (row: HualeiRow): 'platform' | 'day' => (row.clock.endsWith(' 00:00:00') ? 'day' : 'platform');

/**
 * SDK Express's (斯德克) tenant of the Hualei platform. Its lines to Russia go by land through
 * Khorgos; the tracker words its own rows in Chinese and copies the Russian courier's in Russian,
 * without naming the courier or its number.
 */
export const SDK_EXPRESS: HualeiTenant = {
  carrier: 'sdk-express', provider: PROVIDER, origin: SDK_EXPRESS_ORIGIN, stage: sdkExpressStage,
  english: sdkExpressEnglish, clock: sdkExpressClock,
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseSdkExpressTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, SDK_EXPRESS, readAt);
export const parseSdkExpressPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, SDK_EXPRESS, readAt);
